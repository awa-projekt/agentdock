import { ClientFactory } from '@a2a-js/sdk/client';
import { Argument, Command } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { AgentdockApi, AgentIdSchema, AgentSchema, CreateAgentInputSchema, type Agent } from 'agentdock-sdk/api';
import { buildAgentA2aUrl } from 'agentdock-sdk/routes';
import { Console, Data, Effect, Layer, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

const apiBaseUrl = process.env.AGENTDOCK_API_URL ?? 'http://127.0.0.1:38123';

const decodeAgentInput = Schema.decodeUnknownSync(Schema.fromJsonString(CreateAgentInputSchema));
const encodeAgentInput = Schema.encodeSync(Schema.fromJsonString(CreateAgentInputSchema));
const decodeAgent = Schema.decodeUnknownSync(Schema.fromJsonString(AgentSchema));
const encodeAgent = Schema.encodeSync(Schema.fromJsonString(AgentSchema));
const agentIdOf = Schema.decodeUnknownSync(AgentIdSchema);

const makeClient = HttpApiClient.make(AgentdockApi, { baseUrl: apiBaseUrl });

class CliAddAgentError extends Data.TaggedError('CliAddAgentError')<{
  readonly cause: unknown;
}> {}

const toCliAddAgentError = (cause: unknown): CliAddAgentError => new CliAddAgentError({ cause });

const formatList = (values: ReadonlyArray<string>): string => (values.length === 0 ? 'none' : values.join(', '));

const formatCommunication = (agent: Agent): string =>
  agent.communication.allowAll ? 'all agents' : formatList(agent.communication.allowedAgentIds);

const formatAgent = (agent: Agent): string => {
  const rows = [
    ['ID', agent.id],
    ['Name', agent.name],
    ['Description', agent.description],
    ['Version', agent.version],
    ['Model', agent.model],
    ['Instructions', agent.instructions],
    ['Tools', formatList(agent.tools)],
    ['Communication', formatCommunication(agent)],
    ['Capabilities', `streaming=${agent.capabilities.streaming}, pushNotifications=${agent.capabilities.pushNotifications}`],
    ['Input Modes', formatList(agent.defaultInputModes)],
    ['Output Modes', formatList(agent.defaultOutputModes)],
    ['A2A URL', buildAgentA2aUrl(apiBaseUrl, agent.id)],
  ] as const;
  const labelWidth = Math.max(...rows.map(([label]) => label.length));

  return rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`).join('\n');
};

const formatAgents = (agents: ReadonlyArray<Agent>): string => {
  if (agents.length === 0) {
    return 'No agents found.';
  }

  return agents.map(formatAgent).join('\n\n');
};

const asDirectoryUrl = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

const eventText = (event: unknown): string => {
  if (!event || typeof event !== 'object') {
    return '';
  }

  if ('kind' in event && event.kind === 'artifact-update' && 'artifact' in event) {
    const artifact = event.artifact as { readonly parts?: ReadonlyArray<unknown> };
    return artifact.parts?.flatMap((part) => {
      if (part && typeof part === 'object' && 'kind' in part && part.kind === 'text' && 'text' in part) {
        return [String(part.text)];
      }

      return [];
    }).join('') ?? '';
  }

  return '';
};

const listAgents = Effect.gen(function* () {
  const client = yield* makeClient;
  const agents = yield* client.agents.listAgents({});
  yield* Console.log(formatAgents(agents));
});

const addAgent = (input: AgentInput) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL('/agents', apiBaseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodeAgentInput(input),
      });
      const text = await response.text();

      if (!response.ok) {
        throw text || `Failed to add agent: ${response.status}`;
      }

      return decodeAgent(text);
    },
    catch: toCliAddAgentError,
  }).pipe(Effect.flatMap((agent) => Console.log(encodeAgent(agent))));

const updateAgent = (agentId: string, input: AgentInput) =>
  Effect.gen(function* () {
    const client = yield* makeClient;
    const agent = yield* client.agents.updateAgent({ params: { agentId: agentIdOf(agentId) }, payload: input });

    yield* Console.log(encodeAgent(agent));
  });

const addAgentFromJson = (configJson: string) => addAgent(decodeAgentInput(configJson));

const updateAgentFromJson = (agentId: string, configJson: string) => updateAgent(agentId, decodeAgentInput(configJson));

const addAgentFromArgs = (name: string, description: string, instructions: string, model: string) =>
  addAgent({
    name,
    description,
    instructions,
    model,
    tools: [],
    skillIds: [],
    communication: {
      allowAll: false,
      allowedAgentIds: [],
    },
    version: '0.1.0',
    capabilities: {
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  });

const removeAgent = (agentId: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient;
    const result = yield* client.agents.removeAgent({ params: { agentId: agentIdOf(agentId) } });

    yield* Console.log(result.removed ? `Removed agent ${agentId}.` : `Agent ${agentId} was not found.`);
  });

const sendAgentMessage = (agentId: string, message: string) =>
  Effect.tryPromise(async () => {
    const client = await new ClientFactory().createFromUrl(asDirectoryUrl(buildAgentA2aUrl(apiBaseUrl, agentId)));
    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: message }],
      },
    });

    for await (const event of stream) {
      const text = eventText(event);

      if (text.length > 0) {
        process.stdout.write(text);
      }
    }

    process.stdout.write('\n');
  });

type AgentInput = Schema.Schema.Type<typeof CreateAgentInputSchema>;

const agentConfig = Argument.string('config').pipe(
  Argument.withDescription('Agent JSON config with name, description, tools, communication, model, and instructions'),
);
const agentName = Argument.string('name').pipe(Argument.withDescription('Agent name'));
const agentDescription = Argument.string('description').pipe(Argument.withDescription('Agent description'));
const agentInstructions = Argument.string('instructions').pipe(Argument.withDescription('Agent instructions'));
const agentModel = Argument.string('model').pipe(Argument.withDescription('Agent model'));
const agentId = Argument.string('agent-id').pipe(Argument.withDescription('Agent ID'));
const agentMessage = Argument.string('message').pipe(Argument.withDescription('Message to send to the agent'));

const listAgentsCommand = Command.make('list-agents', {}, () => listAgents).pipe(
  Command.withDescription('List all available agents'),
);
const listAgentsJsonCommand = Command.make('list_agents', {}, () => listAgents).pipe(
  Command.withDescription('List all available agents'),
);

const addAgentCommand = Command.make(
  'add-agent',
  {
    name: agentName,
    description: agentDescription,
    instructions: agentInstructions,
    model: agentModel,
  },
  ({ name, description, instructions, model }) => addAgentFromArgs(name, description, instructions, model),
).pipe(Command.withDescription('Add an agent'));
const addAgentJsonCommand = Command.make('add_agent', { config: agentConfig }, ({ config }) => addAgentFromJson(config)).pipe(
  Command.withDescription('Add an agent from a JSON config'),
);

const updateAgentCommand = Command.make(
  'update-agent',
  { agentId, config: agentConfig },
  ({ agentId, config }) => updateAgentFromJson(agentId, config),
).pipe(Command.withDescription('Update an agent from a JSON config'));
const updateAgentJsonCommand = Command.make(
  'update_agent',
  { agentId, config: agentConfig },
  ({ agentId, config }) => updateAgentFromJson(agentId, config),
).pipe(Command.withDescription('Update an agent from a JSON config'));

const removeAgentCommand = Command.make('remove-agent', { agentId }, ({ agentId }) => removeAgent(agentId)).pipe(
  Command.withDescription('Remove an agent'),
);
const removeAgentJsonCommand = Command.make('remove_agent', { agentId }, ({ agentId }) => removeAgent(agentId)).pipe(
  Command.withDescription('Remove an agent'),
);

const sendAgentMessageCommand = Command.make(
  'send-message',
  { agentId, message: agentMessage },
  ({ agentId, message }) => sendAgentMessage(agentId, message),
).pipe(Command.withDescription('Send a message to an agent and stream the response'));
const sendAgentMessageJsonCommand = Command.make(
  'send_message',
  { agentId, message: agentMessage },
  ({ agentId, message }) => sendAgentMessage(agentId, message),
).pipe(Command.withDescription('Send a message to an agent and stream the response'));

const command = Command.make('agentdock', {}).pipe(
  Command.withDescription('Agentdock CLI'),
  Command.withSubcommands([
    listAgentsCommand,
    addAgentCommand,
    updateAgentCommand,
    removeAgentCommand,
    sendAgentMessageCommand,
    listAgentsJsonCommand,
    addAgentJsonCommand,
    updateAgentJsonCommand,
    removeAgentJsonCommand,
    sendAgentMessageJsonCommand,
  ]),
);

const cli = Command.run(command, {
  version: '0.1.0',
});

cli.pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, NodeServices.layer)), NodeRuntime.runMain);
