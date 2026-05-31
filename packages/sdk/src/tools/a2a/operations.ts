import { ClientFactory } from '@a2a-js/sdk/client';
import { type Message, type MessageSendParams, type Task } from '@a2a-js/sdk';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';

export type A2aAgent = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
};

export type A2aAgentRegistry = {
  readonly list: () => Promise<ReadonlyArray<A2aAgent>>;
};

export type ListAgentsResult = ReadonlyArray<A2aAgent>;

export type SendTaskInput = {
  readonly agent_id: string;
  readonly content: string;
};

export type SendTaskResult = {
  readonly message: string;
  readonly task: Task;
};

export type A2aCommunicationOperations = {
  readonly list_agents: () => Promise<ListAgentsResult>;
  readonly send_task: (input: SendTaskInput) => Promise<SendTaskResult>;
};

export type CreateA2aCommunicationOperationsOptions = {
  readonly registry: A2aAgentRegistry;
  readonly sourceAgentId?: string;
  readonly clientFactory?: ClientFactory;
};

const findAgent = async (
  registry: A2aAgentRegistry,
  agentId: string,
  sourceAgentId?: string,
): Promise<A2aAgent> => {
  const agents = await registry.list();
  const agent = agents.find((candidate) => candidate.id === agentId);

  if (!agent) {
    throw new Error(
      sourceAgentId
        ? `Communication not allowed: ${sourceAgentId} -> ${agentId}`
        : `Unknown A2A agent id: ${agentId}`,
    );
  }

  return agent;
};

const createMessageSendParams = ({ content }: SendTaskInput, blocking: boolean): MessageSendParams => ({
  configuration: {
    blocking,
  },
  message: {
    kind: 'message',
    messageId: randomUUID(),
    parts: [
      {
        kind: 'text',
        text: content,
      },
    ],
    role: 'user',
  },
});

const asDirectoryUrl = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

const getTaskFromResult = (result: Message | Task): Task => {
  if (result.kind === 'task') {
    return result;
  }

  throw new Error('A2A agent did not return a task.');
};

const textFromMessage = (message: Message | undefined): string =>
  message?.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('') ?? '';

export const createA2aCommunicationOperations = ({
  registry,
  sourceAgentId,
  clientFactory = new ClientFactory(),
}: CreateA2aCommunicationOperationsOptions): A2aCommunicationOperations => {
  const annotateSourceAgent = sourceAgentId
    ? Effect.annotateCurrentSpan({ 'a2a.source_agent.id': sourceAgentId })
    : Effect.void;

  return {
    list_agents: () =>
      Effect.runPromise(
        Effect.promise(() => registry.list()).pipe(
          Effect.tap(() => annotateSourceAgent),
          Effect.withSpan('agentdock.tools.a2a.list_agents'),
        ),
      ),
    send_task: (input) => {
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* annotateSourceAgent;
          yield* Effect.annotateCurrentSpan({ 'a2a.target_agent.id': input.agent_id });
          const agent = yield* Effect.promise(() => findAgent(registry, input.agent_id, sourceAgentId)).pipe(
            Effect.withSpan('agentdock.tools.a2a.resolve_agent', {
              attributes: { 'a2a.target_agent.id': input.agent_id },
            }),
          );
          yield* Effect.annotateCurrentSpan({ 'a2a.target_agent.url': agent.url });
          const client = yield* Effect.promise(() => clientFactory.createFromUrl(asDirectoryUrl(agent.url))).pipe(
            Effect.withSpan('agentdock.tools.a2a.create_client'),
          );
          const task = getTaskFromResult(
            yield* Effect.promise(() => client.sendMessage(createMessageSendParams(input, true))).pipe(
              Effect.withSpan('agentdock.tools.a2a.send_task.request'),
            ),
          );
          yield* Effect.annotateCurrentSpan({ 'a2a.task.id': task.id, 'a2a.task.state': task.status.state });

          return {
            message: textFromMessage(task.status.message),
            task,
          };
        }).pipe(Effect.withSpan('agentdock.tools.a2a.send_task')),
      );
    },
  };
};
