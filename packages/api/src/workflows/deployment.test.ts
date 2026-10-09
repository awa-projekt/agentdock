import { describe, expect, it } from '@effect/vitest';
import { AgentRecord, Workflow } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { AgentCommunicationPolicy } from '../agents/communication-policy';
import { AgentRegistry } from '../agents/service';
import { IntegrationCatalog } from '../gateway/catalog';
import { SkillRegistry } from '../skills/service';
import { workflowDeploymentFor } from './deployment';
import { WorkflowRegistry } from './service';

const decodeAgent = Schema.decodeUnknownSync(AgentRecord);
const decodeWorkflow = Schema.decodeUnknownSync(Workflow);

const agent = (id: string) =>
  decodeAgent({
    id,
    visibility: 'public',
    name: id,
    description: `The ${id} agent`,
    color: '#2563eb',
    integrations: {},
    skills: {},
    communication: { allowAll: false, allowedAgentIds: [] },
    instructions: `You are ${id}.`,
    model: 'openai:gpt-6-luna',
    version: '1.0.0',
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    revision: 1,
  });

const agents = new Map(['billing', 'ledger', 'audit', 'tech', 'outsider'].map((id) => [id, agent(id)]));

/** billing may delegate to ledger, ledger to audit and back to billing; tech to nobody. */
const targets = new Map<string, ReadonlyArray<string>>([
  ['billing', ['ledger']],
  ['ledger', ['audit', 'billing']],
]);

const services = Layer.mergeAll(
  Layer.mock(AgentRegistry, { getById: (id: string) => Effect.succeed(agents.get(id) ?? null) }),
  Layer.mock(AgentCommunicationPolicy, {
    listAllowedTargets: (id: string) => Effect.succeed((targets.get(id) ?? []).map((target) => agent(target))),
  }),
  Layer.mock(SkillRegistry, { list: () => Effect.succeed([]), listBuiltin: () => [] }),
  Layer.mock(WorkflowRegistry, {}),
  Layer.mock(IntegrationCatalog, {}),
);

const workflow = decodeWorkflow({
  id: 'wf_1',
  source: 'blob',
  sourceHash: 'hash',
  revision: 1,
  manifest: { name: 'Desk', description: 'Answers tickets', version: '0.1.0', agents: { billing: {}, tech: {} } },
  bindings: { billing: { kind: 'agent', id: 'billing' }, tech: { kind: 'agent', id: 'tech' } },
});

describe('workflowDeploymentFor', () => {
  it.effect('pins the agents a bound agent may delegate to, and theirs in turn', () =>
    Effect.gen(function* () {
      const deployment = yield* workflowDeploymentFor(workflow);

      expect(deployment.agents.map((pinned) => pinned.id).sort()).toEqual(['audit', 'billing', 'ledger', 'tech']);
    }).pipe(Effect.provide(services)),
  );
});
