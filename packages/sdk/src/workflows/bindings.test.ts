import { describe, expect, it } from '@effect/vitest';
import * as Schema from 'effect/Schema';
import { AgentRecord, Workflow } from '../schemas';
import { resolveDeploymentBindings } from './bindings';

const decodeAgent = Schema.decodeUnknownSync(AgentRecord);
const decodeWorkflow = Schema.decodeUnknownSync(Workflow);

const writer = decodeAgent({
  id: 'agent-1',
  visibility: 'public',
  name: 'Writer',
  description: 'Writes replies',
  color: '#2563eb',
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: 'Write short replies.',
  model: 'openai:gpt-6-luna',
  reasoningEffort: 'low',
  version: '1.0.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  revision: 1,
});

const workflow = decodeWorkflow({
  id: 'wf_1',
  source: 'blob',
  sourceHash: 'hash',
  revision: 1,
  manifest: {
    name: 'Desk',
    description: 'Answers tickets',
    version: '0.1.0',
    agents: { writer: {} },
    models: {
      triage: { default: 'openai:gpt-6-luna', reasoningEffort: 'low' },
      polish: { default: 'anthropic:claude-test' },
    },
  },
  bindings: {
    writer: { kind: 'agent', id: 'agent-1' },
    triage: { kind: 'model', id: 'openai:gpt-6-luna' },
    polish: { kind: 'model', id: 'anthropic:claude-test' },
  },
});

describe('resolveDeploymentBindings', () => {
  it('runs bound agents and models at the reasoning effort they were given', () => {
    const bindings = resolveDeploymentBindings(workflow, {
      kind: 'workflow',
      workflow,
      agents: [writer],
      externalAgents: [],
      workflows: [],
      tools: [],
    });

    expect(bindings).toEqual([
      {
        name: 'writer',
        kind: 'internal',
        agent: expect.objectContaining({ id: 'agent-1', model: 'openai:gpt-6-luna', reasoningEffort: 'low' }),
      },
      { name: 'triage', kind: 'model', model: 'openai:gpt-6-luna', reasoningEffort: 'low' },
      { name: 'polish', kind: 'model', model: 'anthropic:claude-test', reasoningEffort: undefined },
    ]);
  });
});
