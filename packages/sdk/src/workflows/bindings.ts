import {
  AIMessage,
  type BaseMessage,
  type BaseMessageLike,
  coerceMessageLikeToMessage,
  isAIMessageChunk,
  isBaseMessageChunk,
} from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Predicate from 'effect/Predicate';
import { toA2aPart } from '../a2a/run-record';
import { buildAgentGraph } from '../agents/compose';
import { decorateChatModel, messageParts, renderContentParts } from '../agents/content';
import { type AgentDefinition, agentOutputSchema } from '../agents/definition';
import { inputRequiredRequestFromToolOutput } from '../agents/input-required';
import type { ResolvedModel } from '../agents/loop';
import { ModelProvider, type ModelProviderError } from '../agents/model-provider';
import { contentFormatOf, createChatModel } from '../agents/providers';
import { AgentRunStore } from '../agents/run-store';
import type { AgentToolContext } from '../agents/tool-resolver';
import { randomUUIDv4 } from '../random';
import type { GraphDeployment } from '../runtime/types';
import type {
  AgentRunMessage,
  AgentRunPart,
  AgentRunRecord,
  AgentRunStatus,
  CatalogTool,
  InputContract,
  IntegrationOverrides,
  Json,
  JsonObject,
  ReasoningEffort,
  Workflow,
} from '../schemas';
import {
  AgentCallProgressState,
  AgentLoopProgressState,
  coerceJson,
  isJsonObject,
  ToolCallProgressState,
} from '../schemas';
import { AgentToolRecorder, ModelActivityRecorder, type PublishActivity } from './activity';
import { type AgentInvokerServices, callExternalAgent, inputParts } from './agent-invoker';
import type {
  WorkflowAgent,
  WorkflowAgentInput,
  WorkflowAgentOutput,
  WorkflowChild,
  WorkflowContext,
  WorkflowModel,
  WorkflowTool,
} from './context';
import { publishStepProgress, type StepRef, type WorkflowRunContext } from './events';
import { importWorkflowGraph, loadWorkflowManifest } from './load';
import { WorkflowToolInvoker } from './tool-invoker';

/** What the runtime knows about a bound catalog tool: enough to build the LangChain tool and call it. */
export type WorkflowToolDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject | undefined;
};

/**
 * How a manifest's local name resolves in this deployment. `internal` agents
 * run in-process as native child graphs, `external` ones over a2a against
 * their own URL, `workflow` bindings import the bound artifact and invoke it
 * as a subgraph with its own context, `tool` bindings call an integration
 * tool through the host's {@link WorkflowToolInvoker}, and `model` bindings
 * are platform chat models the code calls itself.
 */
export type WorkflowAgentBinding =
  | {
      readonly name: string;
      readonly kind: 'internal';
      readonly agent: AgentDefinition & { readonly inputContract?: InputContract | null };
    }
  | {
      readonly name: string;
      readonly kind: 'external';
      readonly id: string;
      readonly url: string;
      readonly inputContract?: InputContract | null;
    }
  | {
      readonly name: string;
      readonly kind: 'workflow';
      readonly workflow: Workflow;
      readonly bindings: ReadonlyArray<WorkflowAgentBinding>;
    }
  | {
      readonly name: string;
      readonly kind: 'tool';
      readonly tool: WorkflowToolDefinition;
    }
  | {
      readonly name: string;
      readonly kind: 'model';
      /** The platform model, `provider:model`. */
      readonly model: string;
      readonly reasoningEffort?: ReasoningEffort | undefined;
    };

export type BuildWorkflowContextOptions = {
  readonly bindings: ReadonlyArray<WorkflowAgentBinding>;
  readonly run: WorkflowContext['run'];
  readonly secrets: Readonly<Record<string, string>>;
  readonly runContext: WorkflowRunContext;
  readonly requestMessageId: string;
  readonly deployment?: GraphDeployment | undefined;
  /** Integrations the run reaches somewhere else than registered; its agents' tools and bound tools use them. */
  readonly integrations?: IntegrationOverrides | undefined;
  /** The step whose code is calling, for attributing child runs and progress to it. */
  readonly currentStep: () => StepRef;
  /** The step a task's namespace (`checkpoint_ns`) belongs to, for what runs outside the calling code's context. */
  readonly stepOfNamespace: (checkpointNamespace: string | undefined) => StepRef;
  /** The platform models of the `model` bindings, resolved by {@link resolveBoundModels}. */
  readonly models: Readonly<Record<string, ResolvedModel>>;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E, AgentInvokerServices>) => Promise<A>;
};

/**
 * What a `messages`-mode chunk adds to the assistant turn: text, or a fragment
 * of a tool call's arguments. Agents with an output contract answer through a
 * tool call, so their structured draft streams as argument fragments.
 */
const tokenDeltas = (payload: ReadonlyArray<unknown>): ReadonlyArray<JsonObject> => {
  const [chunk] = payload;
  if (!isBaseMessageChunk(chunk) || !isAIMessageChunk(chunk)) return [];
  const text = Array.isArray(chunk.content)
    ? chunk.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    : chunk.content;
  const deltas: Array<JsonObject> = text.length > 0 ? [{ text }] : [];
  for (const call of chunk.tool_call_chunks ?? []) {
    if (!call.args) continue;
    const toolCall: Record<string, Json> = {};
    if (call.name !== undefined) toolCall.name = call.name;
    if (call.index !== undefined) toolCall.index = call.index;
    deltas.push({ toolCall, args: call.args });
  }
  return deltas;
};

type AgentGraphOutput = { readonly messages: ReadonlyArray<BaseMessage>; readonly structuredResponse?: unknown };

const messageText = (message: BaseMessage): string =>
  Predicate.isString(message.text) ? message.text : JSON.stringify(message.content);

const recordParts = (messages: ReadonlyArray<BaseMessageLike>): ReadonlyArray<AgentRunPart> =>
  messages.flatMap((message) => messageParts(coerceMessageLikeToMessage(message)));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const newId = randomUUIDv4;

/** The last human turn, as the a2a-facing agent input: parsed JSON when it is JSON, else text. */
const lastTurnInput = (messages: ReadonlyArray<BaseMessageLike>): string | Record<string, Json> => {
  const last = messages.at(-1);
  if (!last) return '';
  const text = messageText(coerceMessageLikeToMessage(last));
  try {
    const parsed: Json = coerceJson(JSON.parse(text));
    return isJsonObject(parsed) ? parsed : text;
  } catch {
    return text;
  }
};

const internalAgent = (
  binding: Extract<WorkflowAgentBinding, { kind: 'internal' }>,
  options: BuildWorkflowContextOptions,
): WorkflowAgent =>
  RunnableLambda.from(async (input: WorkflowAgentInput): Promise<WorkflowAgentOutput> => {
    const step = options.currentStep();
    const createdAt = await options.runEffect(nowIso);
    const record: AgentRunRecord = {
      id: await options.runEffect(newId),
      contextId: options.run.contextId,
      agentId: binding.agent.id,
      status: { state: 'working', timestamp: createdAt },
      history: [{ role: 'user', messageId: await options.runEffect(newId), parts: recordParts(input.messages) }],
      artifacts: [],
      origin: {
        surface: 'workflow',
        workflowId: options.run.workflowId,
        workflowRunId: options.run.runId,
        stepId: step.stepId,
        attempt: 1,
      },
      createdAt,
      updatedAt: createdAt,
    };
    const save = (next: AgentRunRecord) => options.runEffect(AgentRunStore.use((store) => store.save(next)));
    await save(record);

    // What the agent does is the step's progress as it happens: its model
    // calls with their usage, its tool calls, its subagents' reports.
    const publish: PublishActivity = (state, data) =>
      options.runEffect(publishStepProgress(options.runContext, step, state, data));
    const tools = new AgentToolRecorder(binding.agent.id, publish);
    const models = new ModelActivityRecorder(
      { agentId: binding.agent.id },
      binding.agent.model,
      () => step,
      (_step, state, data) => publish(state, data),
    );
    const callbacks = [models, tools];

    const toolContext: AgentToolContext = {
      taskId: options.run.taskId,
      contextId: options.run.contextId,
      userMessageId: options.requestMessageId,
      workflow: { ...options.run, stepId: step.stepId },
      integrations: options.integrations,
      emit: (data) =>
        void publish(AgentLoopProgressState.Delegation, { agentId: binding.agent.id, event: coerceJson(data) }),
    };
    const graph = await options.runEffect(
      buildAgentGraph(
        binding.agent,
        options.deployment ? { ...toolContext, deployment: options.deployment } : toolContext,
      ),
    );

    // The agent graph streams its own tokens: LangGraph merges the ambient node
    // config into the nested run by itself, and a `messages` mode on the parent
    // stream would report every token twice from inside a functional-API task.
    try {
      const stream = await graph.stream(
        { messages: [...input.messages] },
        { streamMode: ['messages', 'values'], callbacks },
      );
      let output: AgentGraphOutput | undefined;
      for await (const [mode, payload] of stream) {
        if (mode === 'messages') {
          for (const delta of tokenDeltas(payload)) {
            await options.runEffect(
              publishStepProgress(options.runContext, step, AgentCallProgressState.Artifact, {
                agentId: binding.agent.id,
                ...delta,
              }),
            );
          }
        } else {
          output = payload;
        }
      }
      if (output === undefined) throw new Error(`Agent '${binding.agent.name}' produced no output.`);
      const messages: ReadonlyArray<BaseMessage> = output.messages;
      const structured = 'structuredResponse' in output ? coerceJson(output.structuredResponse) : undefined;
      const finishedAt = await options.runEffect(nowIso);
      const last = messages.at(-1);
      const replyMessageId = last?.id ?? (await options.runEffect(newId));
      const reply: AgentRunMessage | undefined = last
        ? { role: 'agent', messageId: replyMessageId, parts: recordParts([last]) }
        : undefined;
      const status: AgentRunStatus = reply
        ? { state: 'completed', timestamp: finishedAt, message: reply }
        : { state: 'completed', timestamp: finishedAt };
      const toolMessages = await Promise.all(
        tools.recorded.map(
          async (data): Promise<AgentRunMessage> => ({
            role: 'agent',
            messageId: await options.runEffect(newId),
            parts: [{ kind: 'data', data }],
          }),
        ),
      );
      await save({
        ...record,
        status,
        history: [...record.history, ...toolMessages, ...(reply ? [reply] : [])],
        updatedAt: finishedAt,
      });
      return structured === undefined ? { messages } : { messages, structuredResponse: structured };
    } catch (error) {
      const failedAt = await options.runEffect(nowIso);
      const failureMessageId = await options.runEffect(newId);
      await save({
        ...record,
        status: {
          state: 'failed',
          timestamp: failedAt,
          message: {
            role: 'agent',
            messageId: failureMessageId,
            parts: [{ kind: 'text', text: error instanceof Error ? error.message : String(error) }],
          },
        },
        updatedAt: failedAt,
      });
      throw error;
    }
  });

const externalAgent = (
  binding: Extract<WorkflowAgentBinding, { kind: 'external' }>,
  options: BuildWorkflowContextOptions,
): WorkflowAgent =>
  RunnableLambda.from(async (input: WorkflowAgentInput): Promise<WorkflowAgentOutput> => {
    const step = options.currentStep();
    const last = input.messages.at(-1);
    const files =
      last === undefined ? [] : messageParts(coerceMessageLikeToMessage(last)).filter((part) => part.kind === 'file');
    const parts = [...inputParts(binding, lastTurnInput(input.messages)), ...files.map(toA2aPart)];
    const result = await options.runEffect(
      callExternalAgent(options.runContext, binding, step, parts, undefined).pipe(Effect.orDie),
    );
    const messages = [...input.messages.map(coerceMessageLikeToMessage), new AIMessage(result.text)];
    return result.structured === undefined ? { messages } : { messages, structuredResponse: result.structured };
  });

const childWorkflow = (
  binding: Extract<WorkflowAgentBinding, { kind: 'workflow' }>,
  options: BuildWorkflowContextOptions,
): WorkflowChild =>
  RunnableLambda.from(async (input: Json): Promise<Json> => {
    const loaded = await options.runEffect(loadWorkflowManifest(binding.workflow.source).pipe(Effect.orDie));
    const models = await options.runEffect(resolveBoundModels(binding.bindings).pipe(Effect.orDie));
    const context = buildWorkflowContext({
      ...options,
      bindings: binding.bindings,
      models,
      run: { ...options.run, workflowId: binding.workflow.id },
    });
    const compiled = await options.runEffect(importWorkflowGraph(loaded, { context }).pipe(Effect.orDie));
    const output = await compiled.invoke(input, { context });
    return coerceJson(output);
  });

const EMPTY_OBJECT_SCHEMA: JsonObject = { type: 'object', properties: {} };

/**
 * A bound integration tool as a LangChain tool. Every call is reported as
 * progress of the step that made it, so the timeline shows the arguments and
 * the result next to the agent calls.
 *
 * A call the gateway freezes for approval pauses the run on its approval
 * request. The answer decides the approval, and the resumed step calls the
 * tool again with the same arguments, which collects the decided outcome
 * instead of running the tool a second time.
 */
const boundTool = (
  binding: Extract<WorkflowAgentBinding, { kind: 'tool' }>,
  options: BuildWorkflowContextOptions,
): WorkflowTool =>
  tool(
    async (input) => {
      const step = options.currentStep();
      const args = coerceJson(input);
      const report = (state: string, data: JsonObject) =>
        options.runEffect(
          publishStepProgress(options.runContext, step, state, {
            tool: binding.tool.id,
            name: binding.name,
            ...data,
          }),
        );
      const call = async (): Promise<Json> => {
        try {
          return await options.runEffect(
            WorkflowToolInvoker.use((invoker) =>
              invoker.invoke(binding.tool.id, args, { integrations: options.integrations }),
            ),
          );
        } catch (error) {
          await report(ToolCallProgressState.Error, { error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      };
      await report(ToolCallProgressState.Call, { input: args });
      let output = await call();
      // `interrupt` only returns when the step resumed with an answer that was
      // meant for an earlier interrupt of the same step; asking again pauses
      // on this call's own approval.
      for (
        let request = inputRequiredRequestFromToolOutput(output);
        request !== null;
        request = inputRequiredRequestFromToolOutput(output)
      ) {
        interrupt(request);
        output = await call();
      }
      await report(ToolCallProgressState.Result, { output });
      return output;
    },
    {
      name: binding.name,
      description: binding.tool.description,
      schema: binding.tool.inputSchema ?? EMPTY_OBJECT_SCHEMA,
    },
  );

/** The runtime's view of a catalog tool; schemas the catalog could not read are left out rather than guessed. */
export const workflowToolDefinition = (catalogTool: CatalogTool): WorkflowToolDefinition => {
  const definition = { id: catalogTool.id, name: catalogTool.name, description: catalogTool.description };
  return isJsonObject(catalogTool.inputSchema) ? { ...definition, inputSchema: catalogTool.inputSchema } : definition;
};

/** The platform models a workflow's `model` bindings name, resolved on the platform's providers and keys. */
export const resolveBoundModels = (
  bindings: ReadonlyArray<WorkflowAgentBinding>,
): Effect.Effect<Readonly<Record<string, ResolvedModel>>, ModelProviderError, ModelProvider> =>
  Effect.gen(function* () {
    const provider = yield* ModelProvider;
    const resolved: Record<string, ResolvedModel> = {};
    for (const binding of bindings) {
      if (binding.kind === 'model') resolved[binding.name] = yield* provider.resolve(binding.model);
    }
    return resolved;
  });

/**
 * A bound model as the code gets it: the provider's chat model, message parts
 * rendered for its provider, and every call recorded on the calling step.
 */
const boundModel = (
  binding: Extract<WorkflowAgentBinding, { kind: 'model' }>,
  resolved: ResolvedModel,
  options: BuildWorkflowContextOptions,
): WorkflowModel => {
  const format = contentFormatOf(resolved.provider, resolved.config);
  const recorder = new ModelActivityRecorder(
    { modelName: binding.name },
    resolved.model,
    options.stepOfNamespace,
    (step, state, data) => options.runEffect(publishStepProgress(options.runContext, step, state, data)),
  );
  return decorateChatModel(
    resolved.config?.chatModel ??
      createChatModel(resolved.provider, resolved.modelId, resolved.config, binding.reasoningEffort),
    (model) => {
      renderContentParts(model, format);
      model.callbacks = [recorder];
    },
  );
};

/** Builds the `context` a workflow run receives from its resolved bindings. */
export const buildWorkflowContext = (options: BuildWorkflowContextOptions): WorkflowContext => {
  const agents: Record<string, WorkflowAgent> = {};
  const workflows: Record<string, WorkflowChild> = {};
  const tools: Record<string, WorkflowTool> = {};
  const models: Record<string, WorkflowModel> = {};
  for (const binding of options.bindings) {
    switch (binding.kind) {
      case 'internal':
        agents[binding.name] = internalAgent(binding, options);
        break;
      case 'external':
        agents[binding.name] = externalAgent(binding, options);
        break;
      case 'workflow':
        workflows[binding.name] = childWorkflow(binding, options);
        break;
      case 'tool':
        tools[binding.name] = boundTool(binding, options);
        break;
      case 'model': {
        const resolved = options.models[binding.name];
        if (resolved !== undefined) models[binding.name] = boundModel(binding, resolved, options);
        break;
      }
    }
  }
  return { agents, workflows, tools, models, secrets: options.secrets, run: options.run };
};

/**
 * Turns a deployment's snapshotted records into bindings for one workflow,
 * following bound child workflows so each gets its own bindings.
 */
export const resolveDeploymentBindings = (
  workflow: Workflow,
  deployment: Extract<GraphDeployment, { readonly kind: 'workflow' }>,
  seen: ReadonlySet<string> = new Set(),
): ReadonlyArray<WorkflowAgentBinding> =>
  Object.entries(workflow.bindings).flatMap(([name, target]): ReadonlyArray<WorkflowAgentBinding> => {
    if (target.kind === 'agent') {
      const agent = deployment.agents.find((candidate) => candidate.id === target.id);
      if (!agent) return [];
      const outputSchema = agentOutputSchema(agent);
      const definition: AgentDefinition & { inputContract: InputContract | null } = {
        id: agent.id,
        name: agent.name,
        instructions: agent.instructions,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        skills: agent.skills,
        inputContract: agent.inputContract ?? null,
      };
      return [{ name, kind: 'internal', agent: outputSchema ? { ...definition, outputSchema } : definition }];
    }
    if (target.kind === 'external') {
      const agent = deployment.externalAgents.find((candidate) => candidate.id === target.id);
      return agent ? [{ name, kind: 'external', id: agent.id, url: agent.endpointUrl }] : [];
    }
    if (target.kind === 'tool') {
      const catalogTool = deployment.tools.find((candidate) => candidate.id === target.id);
      if (!catalogTool) return [];
      return [{ name, kind: 'tool', tool: workflowToolDefinition(catalogTool) }];
    }
    if (target.kind === 'model') {
      return [
        { name, kind: 'model', model: target.id, reasoningEffort: workflow.manifest.models?.[name]?.reasoningEffort },
      ];
    }
    const child = deployment.workflows.find((candidate) => candidate.id === target.id);
    if (!child || seen.has(child.id)) return [];
    const nextSeen = new Set([...seen, workflow.id]);
    return [
      { name, kind: 'workflow', workflow: child, bindings: resolveDeploymentBindings(child, deployment, nextSeen) },
    ];
  });
