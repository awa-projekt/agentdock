import * as NodeURL from 'node:url';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  AgentCommunicationPolicy,
  AgentCommunicationPolicyLive,
  WILDCARD_TARGET,
} from '../packages/api/src/agents/communication-policy.ts';
import { AgentRegistry, AgentRegistryLive } from '../packages/api/src/agents/service.ts';
import { ensureDatabaseTables } from '../packages/db/src/init.ts';
import type { AgentId, CreateAgentInput } from '../packages/sdk/src/schemas/index.ts';

const sampleAgents: ReadonlyArray<CreateAgentInput> = [
  {
    name: 'planner',
    description: 'Breaks down work and delegates to other agents.',
    integrations: {},
    skills: {},
    communication: {
      allowAll: true,
      allowedAgentIds: [],
    },
    instructions: 'Plan work clearly and delegate to the best available agent when needed.',
    model: 'openai:gpt-5.6-luna',
    reasoningEffort: 'low',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
  {
    name: 'writer',
    description: 'Writes concise drafts and polished copy.',
    integrations: {},
    skills: {},
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    instructions: 'Write concise, polished responses.',
    model: 'openai:gpt-5.6-luna',
    reasoningEffort: 'low',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
  {
    name: 'research',
    description: 'Researches questions and gathers background context.',
    integrations: {},
    skills: {},
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    instructions: 'Research thoroughly and summarize findings with relevant context.',
    model: 'openai:gpt-5.6-luna',
    reasoningEffort: 'low',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
  {
    name: 'content-writer',
    description: 'Drafts publish-ready posts from a brief for human review.',
    integrations: {},
    skills: {},
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    instructions:
      'You are a content writer for a human-reviewed publishing workflow. Given a brief, produce exactly one publish-ready article object. If reviewer feedback is provided, revise the prior draft to address it. Return a concise title, the full markdown body without a leading H1, and the best channel.',
    model: 'openai:gpt-5.6-luna',
    reasoningEffort: 'low',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    outputContract: {
      name: 'content_article',
      description: 'Article payload reviewed by a human and passed to the publishing integration.',
      schema: JSON.stringify({
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          channel: { type: 'string', enum: ['blog', 'twitter', 'linkedin', 'newsletter'] },
        },
        required: ['title', 'body', 'channel'],
        additionalProperties: false,
      }),
    },
  },
];

const appLayer = Layer.mergeAll(AgentRegistryLive, AgentCommunicationPolicyLive);

export const seedAgents = Effect.fn('SeedAgents.seedAgents')(function* () {
  const registry = yield* AgentRegistry;
  const policy = yield* AgentCommunicationPolicy;
  const existingAgents = yield* registry.list();
  const sampleNames = new Set([...sampleAgents.map((agent) => agent.name), 'content-publisher']);

  for (const agent of existingAgents) {
    if (sampleNames.has(agent.name)) {
      yield* registry.remove(agent.id);
    }
  }

  yield* policy.clear();

  const createdAgents = new Map<string, AgentId>();

  for (const agent of sampleAgents) {
    const created = yield* registry.add(agent);
    createdAgents.set(created.name, created.id);
  }

  const plannerId = createdAgents.get('planner');
  const writerId = createdAgents.get('writer');
  const researchId = createdAgents.get('research');
  const contentWriterId = createdAgents.get('content-writer');

  if (!plannerId || !writerId || !researchId || !contentWriterId) {
    throw new Error('Failed to seed sample agents.');
  }

  const writerAgent = sampleAgents.find((agent) => agent.name === 'writer');

  if (!writerAgent) {
    throw new Error('Failed to find writer sample agent.');
  }

  yield* registry.update(writerId, {
    ...writerAgent,
    communication: {
      allowAll: false,
      allowedAgentIds: [researchId],
    },
  });

  yield* policy.replaceForAgent({
    sourceAgentId: plannerId,
    targetAgentIds: [WILDCARD_TARGET],
  });
  yield* policy.replaceForAgent({
    sourceAgentId: writerId,
    targetAgentIds: [researchId],
  });
}, Effect.provide(appLayer));

const main = Effect.gen(function* () {
  yield* ensureDatabaseTables();
  yield* seedAgents();
});

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
}
