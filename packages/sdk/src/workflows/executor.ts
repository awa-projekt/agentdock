import type { Message, MessageSendParams, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { Effect, Layer, Schema } from 'effect';
import { Workflow as EffectWorkflow, WorkflowEngine } from 'effect/unstable/workflow';
import {
  makeAgentDataMessage,
  makeCanceledStatusEvent,
  makeCompletedStatusEvent,
  makeFailedStatusEvent,
  makeMessageStatusEvent,
  makeResponseArtifactEvent,
  makeSubmittedTaskEvent,
  makeWorkingStatusEvent,
} from '../a2a/events';
import { buildAgentA2aUrl } from '../routes';
import { type Agent, type Workflow, type WorkflowEdge, type WorkflowNode } from '../api/schemas';

type WorkflowAgent = Pick<Agent, 'id' | 'name'>;

const textFromMessage = (message: Message | undefined): string =>
  message?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('') ?? '';

const textFromArtifact = (event: TaskArtifactUpdateEvent): string =>
  event.artifact.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');

const textFromTask = (task: Task): string => textFromMessage(task.status.message);

const userText = (message: Message): string => textFromMessage(message);

const template = (value: string, values: ReadonlyMap<string, string>, input: string): string =>
  value.replaceAll('{{input}}', input).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, nodeId: string) => values.get(nodeId) ?? '');

const evaluateCondition = (expression: string | undefined, input: string): boolean => {
  const trimmed = expression?.trim();
  if (!trimmed) {
    return Boolean(input.trim());
  }

  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) {
    return new RegExp(trimmed.slice(1, -1), 'i').test(input);
  }

  return input.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
};

const createMessageSendParams = (content: string): MessageSendParams => ({
  configuration: {
    blocking: false,
  },
  message: {
    kind: 'message',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: content }],
    role: 'user',
  },
});

const nodeInput = (node: WorkflowNode, inbound: ReadonlyMap<string, ReadonlyArray<string>>, values: ReadonlyMap<string, string>, initialInput: string): string => {
  const sourceIds = inbound.get(node.id) ?? [];
  const parts = sourceIds.flatMap((sourceId) => {
    const value = values.get(sourceId);
    return value ? [value] : [];
  });

  return parts.length > 0 ? parts.join('\n') : initialInput;
};

const executionOrder = (workflow: Workflow): ReadonlyArray<WorkflowNode> => {
  const nodesById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  const indegree = new Map(workflow.graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, Array<string>>();

  for (const edge of workflow.graph.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      continue;
    }
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const queue = workflow.graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  const ordered: Array<WorkflowNode> = [];

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (!node) {
      continue;
    }
    ordered.push(node);

    for (const targetId of outgoing.get(node.id) ?? []) {
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextIndegree);
      if (nextIndegree === 0) {
        const target = nodesById.get(targetId);
        if (target) {
          queue.push(target);
        }
      }
    }
  }

  if (ordered.length !== workflow.graph.nodes.length) {
    throw new Error('Workflow graph contains a cycle.');
  }

  return ordered;
};

const nextEdges = (edges: ReadonlyArray<WorkflowEdge>, branch: string | null): ReadonlyArray<WorkflowEdge> =>
  edges.filter((edge) => !edge.condition || edge.condition === branch);

const GraphWorkflow = EffectWorkflow.make({
  name: 'AgentdockGraphWorkflow',
  payload: {
    taskId: Schema.String,
    input: Schema.String,
  },
  idempotencyKey: ({ taskId }) => taskId,
  success: Schema.Struct({
    status: Schema.Literals(['completed', 'canceled']),
    text: Schema.String,
  }),
  error: Schema.String,
});

type WorkflowRunResult = typeof GraphWorkflow.successSchema.Type;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class WorkflowTaskExecutor implements AgentExecutor {
  private readonly canceledTaskIds = new Set<string>();
  private readonly clientFactory = new ClientFactory();

  constructor(
    private readonly workflow: Workflow,
    private readonly agents: ReadonlyArray<WorkflowAgent>,
    private readonly baseUrl: string,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let complete = false;

    try {
      if (!requestContext.task) {
        eventBus.publish(makeSubmittedTaskEvent(requestContext));
      }
      eventBus.publish(makeWorkingStatusEvent(requestContext));

      const initialInput = userText(requestContext.userMessage);
      const workflowLayer = GraphWorkflow.toLayer(({ input }) =>
        Effect.tryPromise({
          try: () => this.executeGraph(requestContext, eventBus, input),
          catch: errorMessage,
        }),
      ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory));
      const result = await Effect.runPromise(
        GraphWorkflow.execute({ taskId: requestContext.taskId, input: initialInput }).pipe(
          Effect.provide(workflowLayer, { local: true }),
        ),
      );

      if (result.status === 'canceled') {
        complete = true;
        return;
      }

      eventBus.publish(makeResponseArtifactEvent(requestContext, this.workflow.name, result.text, false, true));
      eventBus.publish(makeCompletedStatusEvent(requestContext, result.text));
      complete = true;
    } catch (error) {
      eventBus.publish(makeFailedStatusEvent(requestContext, errorMessage(error)));
      complete = true;
    } finally {
      if (complete) {
        eventBus.finished();
      }
    }
  }

  private async executeGraph(requestContext: RequestContext, eventBus: ExecutionEventBus, initialInput: string): Promise<WorkflowRunResult> {
    const values = new Map<string, string>();
    const branches = new Map<string, 'true' | 'false'>();
    const inbound = new Map<string, Array<string>>();
    const outgoing = new Map<string, Array<WorkflowEdge>>();
    const nodesById = new Map(this.workflow.graph.nodes.map((node) => [node.id, node]));
    for (const edge of this.workflow.graph.edges) {
      const sources = inbound.get(edge.target) ?? [];
      sources.push(edge.source);
      inbound.set(edge.target, sources);
      const targets = outgoing.get(edge.source) ?? [];
      targets.push(edge);
      outgoing.set(edge.source, targets);
    }

    const ordered = executionOrder(this.workflow);
    const orderIndex = new Map(ordered.map((node, index) => [node.id, index]));
    const queue = ordered.filter((node) => (inbound.get(node.id) ?? []).length === 0);
    const queued = new Set(queue.map((node) => node.id));
    const completed = new Set<string>();
    const completedOrder: Array<string> = [];

    const publishNodeMessage = (node: WorkflowNode, data: Record<string, unknown>) => {
      eventBus.publish(
        makeMessageStatusEvent(
          requestContext,
          makeAgentDataMessage(requestContext, {
            type: 'workflow-node',
            workflowId: this.workflow.id,
            nodeId: node.id,
            nodeType: node.type,
            label: node.data.label,
            ...data,
          }),
        ),
      );
    };

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const node = queue[queueIndex];
      if (!node || completed.has(node.id)) {
        continue;
      }

      if (this.canceledTaskIds.has(requestContext.taskId)) {
        this.canceledTaskIds.delete(requestContext.taskId);
        eventBus.publish(makeCanceledStatusEvent(requestContext.taskId, requestContext.contextId));
        return { status: 'canceled', text: '' };
      }

      const input = nodeInput(node, inbound, values, initialInput);
      publishNodeMessage(node, { state: 'started', input });

      switch (node.type) {
        case 'input': {
          values.set(node.id, input);
          break;
        }
        case 'template': {
          values.set(node.id, template(node.data.template ?? '{{input}}', values, input));
          break;
        }
        case 'condition': {
          const result = evaluateCondition(node.data.conditionExpression, input);
          const branch = result ? 'true' : 'false';
          branches.set(node.id, branch);
          values.set(node.id, input);
          publishNodeMessage(node, { state: 'branch', branch, conditionExpression: node.data.conditionExpression ?? '' });
          break;
        }
        case 'output': {
          values.set(node.id, template(node.data.template ?? '{{input}}', values, input));
          break;
        }
        case 'agent': {
          const agentId = node.data.agentId;
          const agent = this.agents.find((candidate) => candidate.id === agentId);
          if (!agentId || !agent) {
            throw new Error(`Workflow node '${node.data.label}' does not reference a known agent.`);
          }

          const message = template(node.data.template ?? '{{input}}', values, input);
          publishNodeMessage(node, { state: 'a2a-send', agentId, agentName: agent.name, message });
          const client = await this.clientFactory.createFromUrl(`${buildAgentA2aUrl(this.baseUrl, agentId)}/`);
          let output = '';
          for await (const event of client.sendMessageStream(createMessageSendParams(message))) {
            if (this.canceledTaskIds.has(requestContext.taskId)) {
              this.canceledTaskIds.delete(requestContext.taskId);
              eventBus.publish(makeCanceledStatusEvent(requestContext.taskId, requestContext.contextId));
              return { status: 'canceled', text: '' };
            }

            if (event.kind === 'artifact-update') {
              output += textFromArtifact(event);
              publishNodeMessage(node, { state: 'a2a-artifact', agentId, text: textFromArtifact(event) });
            } else if (event.kind === 'status-update') {
              const statusEvent = event as TaskStatusUpdateEvent;
              const statusText = textFromMessage(statusEvent.status.message);
              if (statusEvent.final && statusText) {
                output = statusText;
              }
              publishNodeMessage(node, {
                state: 'a2a-status',
                agentId,
                taskState: statusEvent.status.state,
                final: statusEvent.final,
                message: statusText,
              });
            } else if (event.kind === 'task') {
              output = textFromTask(event);
              publishNodeMessage(node, { state: 'a2a-task', agentId, taskId: event.id, taskState: event.status.state });
            } else if (event.kind === 'message') {
              const messageText = textFromMessage(event);
              if (messageText) {
                output = messageText;
              }
              publishNodeMessage(node, { state: 'a2a-message', agentId, message: messageText });
            }
          }
          values.set(node.id, output);
          break;
        }
      }

      publishNodeMessage(node, { state: 'completed', output: values.get(node.id) ?? '' });
      completed.add(node.id);
      completedOrder.push(node.id);

      const branch = branches.get(node.id) ?? null;
      const targets = nextEdges(outgoing.get(node.id) ?? [], branch)
        .flatMap((edge) => {
          const target = nodesById.get(edge.target);
          return target ? [target] : [];
        })
        .sort((left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0));

      for (const target of targets) {
        if (!queued.has(target.id)) {
          queued.add(target.id);
          queue.push(target);
        }
      }
    }

    const outputNode = completedOrder.flatMap((nodeId) => {
      const node = nodesById.get(nodeId);
      return node?.type === 'output' ? [node] : [];
    }).at(-1);
    return { status: 'completed', text: (outputNode ? values.get(outputNode.id) : undefined) ?? values.get(completedOrder.at(-1) ?? '') ?? '' };
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.canceledTaskIds.add(taskId);
  }
}
