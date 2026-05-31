import { Effect, Layer } from 'effect';
import { pathToFileURL } from 'node:url';
import { ensureDatabaseTables } from '../packages/db/src/init.ts';
import { AgentCommunicationPolicy, AgentCommunicationPolicyLive, WILDCARD_TARGET } from '../packages/api/src/agents/communication-policy.ts';
import { AgentRegistry, AgentRegistryLive } from '../packages/api/src/agents/service.ts';
import { type CreateAgentInput } from '../packages/api/src/agents/schemas.ts';
import { WorkflowRegistry, WorkflowRegistryLive } from '../packages/api/src/workflows/service.ts';
import { type CreateWorkflowInput } from '../packages/api/src/workflows/schemas.ts';

const sampleAgents: ReadonlyArray<CreateAgentInput> = [
  {
    name: 'planner',
    description: 'Breaks down work and delegates to other agents.',
    tools: [],
    skillIds: [],
    communication: {
      allowAll: true,
      allowedAgentIds: [],
    },
    instructions: 'Plan work clearly and delegate to the best available agent when needed.',
    model: 'openai:gpt-5.4-mini',
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
    tools: [],
    skillIds: [],
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    instructions: 'Write concise, polished responses.',
    model: 'openai:gpt-5.4-mini',
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
    tools: [],
    skillIds: [],
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    instructions: 'Research thoroughly and summarize findings with relevant context.',
    model: 'openai:gpt-5.4-mini',
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
];

const sampleWorkflowNames = new Set(['Urgency router', 'Research or direct draft', 'Research then write', 'Planner summary']);

const appLayer = Layer.mergeAll(AgentRegistryLive, AgentCommunicationPolicyLive, WorkflowRegistryLive);

export const seedAgents = Effect.gen(function* () {
  const registry = yield* AgentRegistry;
  const policy = yield* AgentCommunicationPolicy;
  const workflows = yield* WorkflowRegistry;
  const existingAgents = yield* registry.list();
  const sampleNames = new Set(sampleAgents.map((agent) => agent.name));

  for (const agent of existingAgents) {
    if (sampleNames.has(agent.name)) {
      yield* registry.remove(agent.id);
    }
  }

  yield* policy.clear();

  const createdAgents = new Map<string, string>();

  for (const agent of sampleAgents) {
    const created = yield* registry.add(agent);
    createdAgents.set(created.name, created.id);
  }

  const plannerId = createdAgents.get('planner');
  const writerId = createdAgents.get('writer');
  const researchId = createdAgents.get('research');

  if (!plannerId || !writerId || !researchId) {
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

  for (const workflow of yield* workflows.list()) {
    if (sampleWorkflowNames.has(workflow.name)) {
      yield* workflows.remove(workflow.id);
    }
  }

  const sampleWorkflows: ReadonlyArray<CreateWorkflowInput> = [
    {
      name: 'Urgency router',
      description: 'Branches on urgent requests: planner handles urgent tasks, research handles everything else.',
      version: '0.1.0',
      graph: {
        nodes: [
          { id: 'input', type: 'input', position: { x: 40, y: 160 }, data: { label: 'Incoming task' } },
          { id: 'urgent-check', type: 'condition', position: { x: 300, y: 160 }, data: { label: 'Contains urgent?', conditionExpression: 'urgent' } },
          { id: 'planner', type: 'agent', position: { x: 600, y: 40 }, data: { label: 'Urgent planner', agentId: plannerId, template: 'This is urgent. Make a short action plan:\n\n{{input}}' } },
          { id: 'research', type: 'agent', position: { x: 600, y: 280 }, data: { label: 'Research path', agentId: researchId, template: 'This is not urgent. Research and summarize context for:\n\n{{input}}' } },
          { id: 'output', type: 'output', position: { x: 940, y: 160 }, data: { label: 'Routed result', template: '{{planner}}{{research}}' } },
        ],
        edges: [
          { id: 'input->urgent-check', source: 'input', target: 'urgent-check' },
          { id: 'urgent-check->planner', source: 'urgent-check', target: 'planner', condition: 'true' },
          { id: 'urgent-check->research', source: 'urgent-check', target: 'research', condition: 'false' },
          { id: 'planner->output', source: 'planner', target: 'output' },
          { id: 'research->output', source: 'research', target: 'output' },
        ],
      },
    },
    {
      name: 'Research or direct draft',
      description: 'Branches on whether research is requested, then always asks writer for the final response.',
      version: '0.1.0',
      graph: {
        nodes: [
          { id: 'input', type: 'input', position: { x: 40, y: 160 }, data: { label: 'Incoming task' } },
          { id: 'needs-research', type: 'condition', position: { x: 300, y: 160 }, data: { label: 'Needs research?', conditionExpression: 'research' } },
          { id: 'research', type: 'agent', position: { x: 570, y: 40 }, data: { label: 'Research', agentId: researchId, template: 'Research this before drafting:\n\n{{input}}' } },
          { id: 'direct-template', type: 'template', position: { x: 570, y: 280 }, data: { label: 'Direct brief', template: 'Draft directly from the request:\n\n{{input}}' } },
          { id: 'writer', type: 'agent', position: { x: 880, y: 160 }, data: { label: 'Writer', agentId: writerId, template: 'Write the final response using this context:\n\n{{research}}{{direct-template}}' } },
          { id: 'output', type: 'output', position: { x: 1200, y: 160 }, data: { label: 'Final answer', template: '{{writer}}' } },
        ],
        edges: [
          { id: 'input->needs-research', source: 'input', target: 'needs-research' },
          { id: 'needs-research->research', source: 'needs-research', target: 'research', condition: 'true' },
          { id: 'needs-research->direct-template', source: 'needs-research', target: 'direct-template', condition: 'false' },
          { id: 'research->writer', source: 'research', target: 'writer' },
          { id: 'direct-template->writer', source: 'direct-template', target: 'writer' },
          { id: 'writer->output', source: 'writer', target: 'output' },
        ],
      },
    },
    {
      name: 'Research then write',
      description: 'Planner scopes the task, research gathers context, writer turns both into a polished answer.',
      version: '0.1.0',
      graph: {
        nodes: [
          { id: 'input', type: 'input', position: { x: 40, y: 180 }, data: { label: 'Incoming request' } },
          { id: 'planner', type: 'agent', position: { x: 320, y: 80 }, data: { label: 'Plan approach', agentId: plannerId, template: 'Break this request into the key questions to answer and the final deliverable shape:\n\n{{input}}' } },
          { id: 'research', type: 'agent', position: { x: 640, y: 80 }, data: { label: 'Gather context', agentId: researchId, template: 'Use this plan to gather the most relevant background. Return concise findings with caveats.\n\nPlan:\n{{planner}}\n\nOriginal request:\n{{input}}' } },
          { id: 'brief', type: 'template', position: { x: 640, y: 300 }, data: { label: 'Synthesis brief', template: 'Original request:\n{{input}}\n\nPlan:\n{{planner}}\n\nResearch findings:\n{{research}}' } },
          { id: 'writer', type: 'agent', position: { x: 980, y: 180 }, data: { label: 'Write response', agentId: writerId, template: 'Write a concise, user-ready answer from this brief. Preserve uncertainty and avoid overclaiming.\n\n{{brief}}' } },
          { id: 'output', type: 'output', position: { x: 1320, y: 180 }, data: { label: 'Final response', template: '{{writer}}' } },
        ],
        edges: [
          { id: 'input->planner', source: 'input', target: 'planner' },
          { id: 'planner->research', source: 'planner', target: 'research' },
          { id: 'research->brief', source: 'research', target: 'brief' },
          { id: 'input->brief', source: 'input', target: 'brief' },
          { id: 'planner->brief', source: 'planner', target: 'brief' },
          { id: 'brief->writer', source: 'brief', target: 'writer' },
          { id: 'writer->output', source: 'writer', target: 'output' },
        ],
      },
    },
    {
      name: 'Planner summary',
      description: 'Runs planner and research in parallel, then asks writer to produce an executive summary and next actions.',
      version: '0.1.0',
      graph: {
        nodes: [
          { id: 'input', type: 'input', position: { x: 40, y: 180 }, data: { label: 'Problem statement' } },
          { id: 'planner', type: 'agent', position: { x: 360, y: 40 }, data: { label: 'Execution plan', agentId: plannerId, template: 'Create a practical execution plan for this request. Include risks and sequencing.\n\n{{input}}' } },
          { id: 'research', type: 'agent', position: { x: 360, y: 320 }, data: { label: 'Background scan', agentId: researchId, template: 'Research the background, constraints, and facts needed for this request.\n\n{{input}}' } },
          { id: 'summary-context', type: 'template', position: { x: 720, y: 180 }, data: { label: 'Combined context', template: 'Request:\n{{input}}\n\nPlanner output:\n{{planner}}\n\nResearch output:\n{{research}}' } },
          { id: 'writer', type: 'agent', position: { x: 1040, y: 180 }, data: { label: 'Executive summary', agentId: writerId, template: 'Turn this into an executive summary with: 1. decision, 2. rationale, 3. next actions.\n\n{{summary-context}}' } },
          { id: 'output', type: 'output', position: { x: 1360, y: 180 }, data: { label: 'Summary', template: '{{writer}}' } },
        ],
        edges: [
          { id: 'input->planner', source: 'input', target: 'planner' },
          { id: 'input->research', source: 'input', target: 'research' },
          { id: 'input->summary-context', source: 'input', target: 'summary-context' },
          { id: 'planner->summary-context', source: 'planner', target: 'summary-context' },
          { id: 'research->summary-context', source: 'research', target: 'summary-context' },
          { id: 'summary-context->writer', source: 'summary-context', target: 'writer' },
          { id: 'writer->output', source: 'writer', target: 'output' },
        ],
      },
    },
  ];

  for (const workflow of sampleWorkflows) {
    yield* workflows.add(workflow);
  }
}).pipe(Effect.provide(appLayer));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Effect.runPromise(ensureDatabaseTables());
  await Effect.runPromise(seedAgents);
}
