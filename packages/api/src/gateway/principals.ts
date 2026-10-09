import { AccessProfileId, type Client, ClientId } from '@integragents/contracts';
import { defaultTenantId, type GatewayStore, newClientId } from '@integragents/gateway-core';
import type { ApprovalPrincipal } from 'agentdock-sdk/schemas';
import { type DatabaseClient, gatewayPrincipalsTable, tryDbWith } from 'db';
import { and, eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { operationError } from './errors';

/**
 * Who a gateway client stands for. Agents hold their own access profile so
 * tools are enabled per agent; workflows and the platform itself run on the
 * tenant's default profile, which the gateway keeps in step with the catalog.
 */
export type Principal = ApprovalPrincipal;

export const platformPrincipal: Principal = { kind: 'platform', id: 'agentdock', name: 'Agentdock' };

export const agentPrincipal = (agentId: string): Principal => ({ kind: 'agent', id: agentId, name: agentId });

export const workflowPrincipal = (workflowId: string): Principal => ({
  kind: 'workflow',
  id: workflowId,
  name: workflowId,
});

export type PrincipalClient = {
  readonly client: Client;
  readonly accessProfileId: AccessProfileId;
};

const tryDb = tryDbWith(operationError);

const agentAccessProfileId = (agentId: string): AccessProfileId => AccessProfileId.make(`agent:${agentId}`);

export const createPrincipals = (db: DatabaseClient, store: GatewayStore) => {
  const tenantId = defaultTenantId;

  const findRow = (principal: Principal) =>
    tryDb(() =>
      db
        .select()
        .from(gatewayPrincipalsTable)
        .where(and(eq(gatewayPrincipalsTable.kind, principal.kind), eq(gatewayPrincipalsTable.refId, principal.id)))
        .limit(1)
        .all(),
    ).pipe(Effect.map((rows) => rows[0]));

  const accessProfileFor = Effect.fn('Principals.accessProfileFor')(function* (principal: Principal) {
    if (principal.kind === 'agent') {
      const id = agentAccessProfileId(principal.id);
      const existing = yield* store.findAccessProfile(tenantId, id);
      return existing ?? (yield* store.createAccessProfile({ tenantId, id, name: `Agent ${principal.id}` }));
    }
    const shared = yield* store.findDefaultAccessProfile(tenantId);
    if (shared === undefined) return yield* operationError('The gateway tenant has no default access profile');
    return shared;
  });

  const ensure = Effect.fn('Principals.ensure')(function* (principal: Principal) {
    const row = yield* findRow(principal);
    if (row !== undefined) {
      const client = yield* store.findClientById(tenantId, ClientId.make(row.clientId));
      if (client !== undefined && client.revokedAt === null) {
        return { client, accessProfileId: AccessProfileId.make(row.accessProfileId) };
      }
    }
    const accessProfile = yield* accessProfileFor(principal);
    const approvalPolicy = yield* store.findDefaultApprovalPolicy(tenantId);
    if (approvalPolicy === undefined) return yield* operationError('The gateway tenant has no default approval policy');
    const client = yield* store.createClient({
      tenantId,
      id: yield* newClientId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: `${principal.kind}:${principal.id}`,
      capabilities: [],
    });
    const createdAt = yield* Clock.currentTimeMillis;
    yield* tryDb(() =>
      db
        .insert(gatewayPrincipalsTable)
        .values({
          kind: principal.kind,
          refId: principal.id,
          clientId: client.id,
          accessProfileId: accessProfile.id,
          createdAt,
        })
        .onConflictDoUpdate({
          target: [gatewayPrincipalsTable.kind, gatewayPrincipalsTable.refId],
          set: { clientId: client.id, accessProfileId: accessProfile.id },
        })
        .run(),
    );
    return { client, accessProfileId: accessProfile.id };
  });

  const byClientId = Effect.fn('Principals.byClientId')(function* () {
    const rows = yield* tryDb(() => db.select().from(gatewayPrincipalsTable).all());
    return new Map<string, Principal>(
      rows.map((row) => [row.clientId, { kind: row.kind, id: row.refId, name: row.refId }]),
    );
  });

  return { ensure, byClientId };
};

export type Principals = ReturnType<typeof createPrincipals>;
