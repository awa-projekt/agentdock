import { MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import type { AgentRunMessage, AgentRunPart, AgentRunRecord } from '../schemas/agent-runs';
import type { Json, JsonObject } from '../schemas/json';
import type { ReasoningEffort } from '../schemas/reasoning';
import type { AgentToolSet } from '../tools';
import type { AgentDefinition } from './definition';
import { AgentLoopFactoryLive } from './langgraph-loop';
import type { AgentLoopEvent, AgentLoopFactory, AgentLoopInput, ResolvedModel } from './loop';
import { ModelProvider, ModelProviderError, parseModelString } from './model-provider';
import type { ModelRuntimeConfig } from './providers';
import { type AgentRunResult, runAgent } from './run';
import { AgentRunStore, AgentRunStoreError } from './run-store';
import { AgentToolResolver, ToolResolverError } from './tool-resolver';

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Identity of an agent: what it is, independent of which model/tools run it. */
export type AgentIdentity = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  /** Parsed JSON Schema; when set the agent runs with structured output. */
  readonly outputSchema?: JsonObject | undefined;
  /** How hard the model thinks; absent leaves the provider default. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
};

/** Given to `resolveModel` for a prompt: the `provider:model` string split in two. */
export type ModelResolverContext = { readonly provider: string; readonly model: string };
/**
 * Resolves the runtime config (api key, base URL, or a prebuilt chat model via
 * `config.chatModel`) for a provider:model pair. Harness-neutral by design:
 * the loop factory receives a `ResolvedModel`, never a constructed client.
 */
export type ModelResolver = (
  context: ModelResolverContext,
) => Promise<ModelRuntimeConfig | undefined> | ModelRuntimeConfig | undefined;

/** Given to `resolveTools` for a prompt: the agent's identity and the run it's for. */
export type ToolResolverContext = {
  readonly agent: AgentIdentity;
  readonly taskId: string;
  readonly contextId: string;
};
export type AgentToolResolverFn = (context: ToolResolverContext) => Promise<AgentToolSet>;

/**
 * A plain (Promise-based) run-record store an `Agent` persists to. Only
 * `save`/`get` are needed for a single agent's own continuity — cross-run
 * queries (`listByContext`, etc.) are a host concern, not an agent-level one;
 * wire a full `AgentRunStore` layer directly if you need those.
 */
export type AgentRunRecordStore = {
  readonly save: (record: AgentRunRecord) => Promise<void>;
  readonly get: (id: string) => Promise<AgentRunRecord | null>;
};

/** `Agent`'s default `runStore`: in-memory, one instance's records, gone when the process exits. */
export class MemoryRunStore implements AgentRunRecordStore {
  private readonly records = new Map<string, AgentRunRecord>();

  async save(record: AgentRunRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<AgentRunRecord | null> {
    return this.records.get(id) ?? null;
  }
}

export type ModelConfig =
  | { readonly modelId: string; readonly resolveModel?: never }
  | { readonly modelId?: string; readonly resolveModel: ModelResolver };

export type ToolsConfig =
  | { readonly tools?: AgentToolSet; readonly resolveTools?: never }
  | { readonly tools?: never; readonly resolveTools: AgentToolResolverFn };

export type AgentOptions = AgentIdentity &
  ModelConfig &
  ToolsConfig & {
    readonly runStore?: AgentRunRecordStore;
    /**
     * Defaults to an in-memory `MemorySaver` per instance, which is what makes
     * multi-turn conversations (and interrupt/resume) work out of the box.
     * Pass a durable checkpointer (e.g. sqlite) to survive process restarts.
     */
    readonly checkpointer?: BaseCheckpointSaver;
  };

export type AgentPromptOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type AgentState = {
  readonly contextId: string | undefined;
  readonly taskId: string | undefined;
  readonly status: AgentRunResult['status'] | 'idle';
  readonly text: string | undefined;
  readonly structured: JsonObject | undefined;
  /** Present after a turn ended `input-required`; pass your answer to `resume()`. */
  readonly inputRequired: JsonObject | undefined;
  readonly history: ReadonlyArray<AgentRunMessage>;
};

export type AgentEventHandler = (event: AgentLoopEvent) => void | Promise<void>;

/**
 * A stateful, conversational agent: constructor takes a model/tools directly
 * (or `resolveModel`/`resolveTools` for hosts that resolve those dynamically
 * per call), and the instance owns its own contextId/taskId continuity across
 * `prompt()` calls. No Effect types appear in this class's public surface —
 * internally it builds a one-off `Layer` per prompt and discharges the
 * existing Effect-native `runAgent`/`AgentLoopFactory` machinery, so hosted
 * code (`packages/api`) and this class exercise the exact same execution
 * path, just with different plumbing supplied.
 *
 * Distinct from the `AgentRecord` schema type (`agentdock-sdk/schemas`),
 * which is the platform's persisted agent configuration; an `Agent` is a live
 * runnable instance built from that kind of configuration.
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly outputSchema: JsonObject | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;

  private resolveModelFn: ModelResolver | undefined;
  private readonly modelId: string;

  private tools: AgentToolSet | undefined;
  private resolveToolsFn: AgentToolResolverFn | undefined;

  private readonly runStore: AgentRunRecordStore;
  private readonly checkpointer: BaseCheckpointSaver;

  private readonly subscribers = new Set<AgentEventHandler>();

  private contextId: string | undefined;
  private taskId: string | undefined;
  private lastRecord: AgentRunRecord | undefined;
  private lastResult: AgentRunResult | undefined;

  private activeAbort: AbortController | null = null;
  private idlePromise: Promise<void> = Promise.resolve();

  constructor(options: AgentOptions) {
    this.id = options.id;
    this.name = options.name;
    this.instructions = options.instructions;
    this.outputSchema = options.outputSchema;
    this.reasoningEffort = options.reasoningEffort;

    this.resolveModelFn = options.resolveModel;
    this.modelId = options.modelId ?? `direct:${options.id}`;

    this.tools = options.tools;
    this.resolveToolsFn = options.resolveTools;

    this.runStore = options.runStore ?? new MemoryRunStore();
    this.checkpointer = options.checkpointer ?? new MemorySaver();
  }

  /** Reattaches to an existing conversation, priming `state` from its run store. */
  static async restore(
    options: AgentOptions & { readonly contextId: string; readonly taskId?: string },
  ): Promise<Agent> {
    const agent = new Agent(options);
    agent.contextId = options.contextId;
    if (options.taskId) {
      agent.taskId = options.taskId;
      agent.lastRecord = (await agent.runStore.get(options.taskId)) ?? undefined;
    }
    return agent;
  }

  /**
   * Sets the model resolver used by subsequent `prompt()` calls, replacing any
   * constructor-provided one.
   */
  setModelResolver(resolveModel: ModelResolver): void {
    this.resolveModelFn = resolveModel;
  }

  /** Swaps the tool set (or tool resolver) used by subsequent `prompt()` calls. */
  setTools(tools: AgentToolSet): void {
    this.tools = tools;
    this.resolveToolsFn = undefined;
  }

  /** A synchronous snapshot of the last known run outcome — refreshed after every `prompt()`/`resume()`/`restore()`. */
  get state(): AgentState {
    return {
      contextId: this.contextId,
      taskId: this.taskId,
      status: this.lastResult?.status ?? 'idle',
      text: this.lastResult?.text,
      structured: this.lastResult?.structured,
      inputRequired: this.lastResult?.inputRequired,
      history: this.lastRecord?.history ?? [],
    };
  }

  /** Registers a handler for every loop event across all future prompts; returns an unsubscribe function. */
  subscribe(handler: AgentEventHandler): () => void {
    this.subscribers.add(handler);
    return () => void this.subscribers.delete(handler);
  }

  /** Aborts the in-flight `prompt()`/`resume()` call, if any. */
  abort(): void {
    this.activeAbort?.abort();
  }

  /** Resolves once no `prompt()`/`resume()` call is in flight. */
  async waitForIdle(): Promise<void> {
    await this.idlePromise;
  }

  /** Clears conversation continuity (contextId/taskId/history) — the next `prompt()` starts a fresh conversation. */
  reset(): void {
    this.abort();
    this.contextId = undefined;
    this.taskId = undefined;
    this.lastRecord = undefined;
    this.lastResult = undefined;
  }

  /**
   * Overwrites the current run record's history directly (no new turn is run).
   * Requires an active session (`prompt()` at least once, or `restore()`).
   */
  async replaceMessages(history: ReadonlyArray<AgentRunMessage>): Promise<void> {
    if (!this.taskId) {
      throw new Error('Agent.replaceMessages requires an active session — call prompt() first or use Agent.restore().');
    }
    const existing = this.lastRecord ?? (await this.runStore.get(this.taskId)) ?? undefined;
    if (!existing) {
      throw new Error(`Agent.replaceMessages: no run record found for taskId '${this.taskId}'.`);
    }
    const updatedAt = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const updated: AgentRunRecord = { ...existing, history: [...history], updatedAt };
    await this.runStore.save(updated);
    this.lastRecord = updated;
  }

  /**
   * Runs one turn, continuing this instance's conversation if `prompt()` has
   * run before. Text, or message parts to send files and data along.
   */
  async prompt(input: string | ReadonlyArray<AgentRunPart>, options?: AgentPromptOptions): Promise<AgentRunResult> {
    return this.runTurn({ parts: Predicate.isString(input) ? [{ kind: 'text', text: input }] : input }, options);
  }

  async resume(response: Json, options?: AgentPromptOptions): Promise<AgentRunResult> {
    if (this.lastResult?.status !== 'input-required') {
      throw new Error(
        `Agent.resume is only valid while a turn is paused input-required (current status: '${this.state.status}').`,
      );
    }
    return this.runTurn({ resume: response }, options);
  }

  private async runTurn(input: AgentLoopInput, options?: AgentPromptOptions): Promise<AgentRunResult> {
    if (this.activeAbort) {
      throw new Error(`Agent '${this.id}' already has a turn in flight — await waitForIdle() before starting another.`);
    }

    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      else options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    this.activeAbort = abortController;

    let resolveIdle: () => void = () => {};
    this.idlePromise = new Promise((resolve) => {
      resolveIdle = resolve;
    });

    try {
      const result = await Effect.runPromise(
        runAgent(this.definition(), input, {
          taskId: this.taskId,
          contextId: this.contextId,
          origin: { surface: 'sdk' },
          checkpointer: this.checkpointer,
          signal: abortController.signal,
          onEvent: (event) => this.dispatch(event),
        }).pipe(Effect.provide(this.buildLayer())),
      );

      this.taskId = result.taskId;
      this.contextId = result.contextId;
      this.lastResult = result;
      this.lastRecord = result.record;
      return result;
    } finally {
      this.activeAbort = null;
      resolveIdle();
    }
  }

  private definition(): AgentDefinition {
    return {
      id: this.id,
      name: this.name,
      instructions: this.instructions,
      model: this.modelId,
      reasoningEffort: this.reasoningEffort,
      outputSchema: this.outputSchema,
    };
  }

  private async dispatch(event: AgentLoopEvent): Promise<void> {
    await Promise.all([...this.subscribers].map((handler) => handler(event)));
  }

  private buildLayer(): Layer.Layer<AgentLoopFactory | ModelProvider | AgentToolResolver | AgentRunStore> {
    const modelProviderLayer = Layer.succeed(
      ModelProvider,
      ModelProvider.of({
        resolve: (model) => {
          const { provider, modelId } = parseModelString(model);
          if (!this.resolveModelFn) return Effect.succeed({ model, provider, modelId });
          return Effect.tryPromise({
            try: async () => {
              const config = await this.resolveModelFn!({ provider, model: modelId });
              return { model, provider, modelId, config: config ?? undefined } satisfies ResolvedModel;
            },
            catch: (error) => new ModelProviderError({ message: errorMessage(error), error }),
          });
        },
      }),
    );

    const toolResolverLayer = Layer.succeed(
      AgentToolResolver,
      AgentToolResolver.of({
        resolve: (_agent, context) =>
          this.resolveToolsFn
            ? Effect.tryPromise({
                try: () =>
                  this.resolveToolsFn!({
                    agent: {
                      id: this.id,
                      name: this.name,
                      instructions: this.instructions,
                      outputSchema: this.outputSchema,
                    },
                    taskId: context.taskId,
                    contextId: context.contextId,
                  }),
                catch: (error) => new ToolResolverError({ message: errorMessage(error), error }),
              })
            : Effect.succeed(this.tools ?? []),
      }),
    );

    const notSupported = (method: string) =>
      Effect.fail(
        new AgentRunStoreError({
          message: `Agent's runStore only supports save/get; '${method}' isn't available. Provide a full AgentRunStore layer directly if you need it.`,
          error: undefined,
        }),
      );

    const runStoreLayer = Layer.succeed(
      AgentRunStore,
      AgentRunStore.of({
        save: (record) =>
          Effect.tryPromise({
            try: () => this.runStore.save(record),
            catch: (error) => new AgentRunStoreError({ message: errorMessage(error), error }),
          }),
        get: (id) =>
          Effect.tryPromise({
            try: () => this.runStore.get(id),
            catch: (error) => new AgentRunStoreError({ message: errorMessage(error), error }),
          }),
        listByContext: () => notSupported('listByContext'),
        listByWorkflowRun: () => notSupported('listByWorkflowRun'),
        delete: () => notSupported('delete'),
      }),
    );

    return Layer.mergeAll(AgentLoopFactoryLive, modelProviderLayer, toolResolverLayer, runStoreLayer);
  }
}
