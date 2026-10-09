import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import type { Runnable, RunnableConfig } from '@langchain/core/runnables';
import type { Graph as DrawableGraph } from '@langchain/core/runnables/graph';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseCheckpointSaver, CommandInstance, StateSnapshot } from '@langchain/langgraph';
import type { Json } from '../schemas/json';

/**
 * The contract between agentdock and a workflow artifact.
 *
 * An artifact exports a compiled LangGraph, built without a checkpointer. It
 * imports nothing from agentdock. At invoke time the host supplies:
 *
 *   - the durable checkpointer, through LangGraph's `__pregel_checkpointer`
 *     configurable, exactly as LangGraph Platform does;
 *   - a {@link WorkflowContext} as the LangGraph runtime `context`, which every
 *     node receives as `config.context` (or `getConfig().context` in the
 *     functional API).
 *
 *   // workflow.ts — no agentdock import
 *   const graph = new StateGraph(State)
 *     .addNode('draft', async (state, config) => {
 *       const writer = config.context.agents.writer;
 *       const out = await writer.invoke({ messages: [{ role: 'user', content: state.text }] });
 *       return { reply: String(out.messages.at(-1)?.content) };
 *     })
 *     .compile();
 *   export default graph;
 *
 * Locally the developer passes their own `context` when invoking the graph; on
 * the platform the runtime builds it from the workflow's bindings.
 */
export type WorkflowAgentInput = { readonly messages: ReadonlyArray<BaseMessageLike> };

export type WorkflowAgentOutput = {
  readonly messages: ReadonlyArray<BaseMessage>;
  /** Present when the agent declares a structured output contract. */
  readonly structuredResponse?: Json;
};

/** An agent as the workflow sees it: a runnable over messages, whatever runs behind it. */
export type WorkflowAgent = Runnable<WorkflowAgentInput, WorkflowAgentOutput>;

/** A registered workflow as a callable: task input in, final output out. */
export type WorkflowChild = Runnable<Json, Json>;

/**
 * A bound integration tool as a LangChain tool: invoke it directly with its
 * arguments, or hand it to a model inside the workflow.
 */
export type WorkflowTool = StructuredToolInterface;

/**
 * A bound platform model as a LangChain chat model: invoke it, stream it, bind
 * tools or ask for structured output. It runs on the platform's provider keys
 * and every call is recorded on the calling step.
 */
export type WorkflowModel = BaseChatModel;

export type WorkflowContext = {
  /** Bound agents, keyed by the manifest's local names. */
  readonly agents: Readonly<Record<string, WorkflowAgent>>;
  /** Bound workflows, keyed by the manifest's local names. */
  readonly workflows: Readonly<Record<string, WorkflowChild>>;
  /** Bound integration tools, keyed by the manifest's local names. */
  readonly tools: Readonly<Record<string, WorkflowTool>>;
  /** Bound platform models, keyed by the manifest's local names. */
  readonly models: Readonly<Record<string, WorkflowModel>>;
  /** Values for the secret names the manifest declares. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly run: {
    readonly workflowId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly contextId: string;
  };
};

/**
 * The subset of a compiled LangGraph the host drives. Anything returned by
 * `StateGraph#compile` or `entrypoint(...)` satisfies this structurally.
 * Method shorthand keeps LangGraph's concretely-typed `stream` assignable.
 */
/**
 * The state a compiled graph returns. LangGraph state is a record whose values
 * are whatever the artifact's own channels hold, so the host coerces it into the
 * Json domain before reading it.
 */
export type WorkflowGraphState = object;

export type CompiledWorkflow = {
  readonly checkpointer?: BaseCheckpointSaver | boolean;
  getState(options: WorkflowStreamOptions): Promise<StateSnapshot>;
  invoke(
    input: WorkflowStreamInput,
    options?: RunnableConfig & { readonly context?: WorkflowContext },
  ): Promise<WorkflowGraphState>;
  stream(input: WorkflowStreamInput, options?: WorkflowStreamOptions): Promise<AsyncIterable<WorkflowStreamChunk>>;
  getGraphAsync(options: WorkflowGraphOptions): Promise<DrawableGraph>;
  /** `StateGraph` builders carry the declared input/output schemas the registry derives contracts from. */
  readonly builder?: {
    readonly _inputRuntimeDefinition?: unknown;
    readonly _outputRuntimeDefinition?: unknown;
  };
};

/** What the manifest's `graph` export may be: the compiled graph, or a function producing one. */
export type WorkflowGraphExport =
  | CompiledWorkflow
  | ((runtime: { readonly context?: WorkflowContext }) => CompiledWorkflow | Promise<CompiledWorkflow>);

export type WorkflowGraphOptions = RunnableConfig & { readonly xray?: boolean | number };

export type WorkflowStreamInput = Json | CommandInstance | null;

/** LangGraph reads the checkpointer from this configurable when the graph was compiled without one. */
export const CHECKPOINTER_CONFIG_KEY = '__pregel_checkpointer';

export type WorkflowStreamOptions = {
  readonly metadata?: { readonly request_id: string };
  readonly configurable?: {
    readonly thread_id?: string;
    readonly [CHECKPOINTER_CONFIG_KEY]?: BaseCheckpointSaver;
  };
  readonly context?: WorkflowContext;
  readonly streamMode?: Array<'updates' | 'custom' | 'values' | 'tasks'>;
  readonly durability?: 'sync' | 'async' | 'exit';
  readonly recursionLimit?: number;
  readonly subgraphs?: boolean;
  readonly signal?: AbortSignal;
};

export type WorkflowStreamChunk = readonly [string, unknown] | readonly [ReadonlyArray<string>, string, unknown];

export const INTERRUPT_CHUNK_KEY = '__interrupt__';

/** Packages an artifact must take from the host rather than install itself, so `instanceof` checks hold. */
export const HOST_PROVIDED_PACKAGES = [
  '@langchain/langgraph',
  '@langchain/core',
  'langchain',
  'agentdock-patterns',
] as const;

export type HostProvidedPackage = (typeof HOST_PROVIDED_PACKAGES)[number];

/**
 * Host-provided packages that ship with agentdock rather than the npm
 * registry. Artifacts declare them as optional peers, so `bun install` records
 * the range without trying to fetch them.
 */
export const BUNDLED_HOST_PACKAGES: ReadonlyArray<HostProvidedPackage> = ['agentdock-patterns'];
