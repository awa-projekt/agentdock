import { describe, expect, it } from '@effect/vitest';
import { INTEGRATION_OVERRIDES_METADATA_KEY, IntegrationSlug, type Json } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { admitIntegrationOverrides, type OverrideAdmission } from './integration-overrides';

/** A platform with an MCP integration `catalog` and an OpenAPI one `crm`, asked by a caller of the given role. */
const asCaller = (role: string | null): OverrideAdmission => ({
  callerRole: Effect.succeed(role),
  integrations: Effect.succeed([
    { slug: IntegrationSlug.make('catalog'), kind: 'mcp' },
    { slug: IntegrationSlug.make('crm'), kind: 'openapi' },
  ]),
});

const send = (overrides: Json): Json => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      messageId: 'm-1',
      role: 'user',
      parts: [{ kind: 'text', text: 'Research product 42.' }],
      metadata: { [INTEGRATION_OVERRIDES_METADATA_KEY]: overrides },
    },
  },
});

const caseServer = { catalog: { endpoint: 'http://127.0.0.1:41001/mcp' } };

describe('admitIntegrationOverrides', () => {
  it.effect('admits an admin pointing an MCP integration at an http endpoint', () =>
    Effect.gen(function* () {
      expect(yield* admitIntegrationOverrides(send(caseServer), asCaller('admin'))).toEqual(Option.none());
    }),
  );

  it.effect('refuses anyone else, signed in or not', () =>
    Effect.gen(function* () {
      expect(Option.isSome(yield* admitIntegrationOverrides(send(caseServer), asCaller('user')))).toBe(true);
      expect(Option.isSome(yield* admitIntegrationOverrides(send(caseServer), asCaller(null)))).toBe(true);
    }),
  );

  it.effect('refuses unknown or non-MCP integrations, other endpoints and malformed overrides', () =>
    Effect.gen(function* () {
      const refusal = (overrides: Json) =>
        admitIntegrationOverrides(send(overrides), asCaller('admin')).pipe(Effect.map(Option.getOrUndefined));
      expect(yield* refusal({ nowhere: { endpoint: 'http://127.0.0.1:1/mcp' } })).toContain("No integration 'nowhere'");
      expect(yield* refusal({ crm: { endpoint: 'http://127.0.0.1:1/api' } })).toContain('not an MCP integration');
      expect(yield* refusal({ catalog: { endpoint: 'file:///etc/passwd' } })).toContain('http(s) URL');
      expect(yield* refusal({ catalog: 'http://127.0.0.1:1/mcp' })).toContain('must map integration slugs');
    }),
  );

  it.effect('lets through requests that set no overrides, whoever sends them', () =>
    Effect.gen(function* () {
      const plain: Json = {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { kind: 'message', messageId: 'm-1', role: 'user', parts: [] } },
      };
      expect(yield* admitIntegrationOverrides(plain, asCaller(null))).toEqual(Option.none());
      expect(yield* admitIntegrationOverrides({ jsonrpc: '2.0', id: 2, method: 'tasks/get' }, asCaller(null))).toEqual(
        Option.none(),
      );
    }),
  );
});
