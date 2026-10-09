import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  END,
  type LangGraphRunnableConfig,
  MessagesValue,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
import { z } from 'zod';
import {
  type Agent,
  answerMessage,
  type Checkpointer,
  checkNames,
  compileOptions,
  finalText,
  nodeOptions,
  type RetryPolicy,
  type StepTimeout,
  toText,
} from './core.ts';
import { type ModelLike, modelResolver, type StructuredOutputMethod, structuredCall } from './models.ts';

/**
 * Sequential pipeline (prompt chaining) with gates. Steps run in order; each
 * reads the original request plus every earlier step's output and records its
 * own under `outputs[name]`. A gate checked after a step stops the pipeline
 * early, optionally with a fallback result.
 *
 *     createPipeline({
 *       steps: [
 *         structuredStep({ name: 'classify', model: contextModel('classifier'), systemPrompt: '…',
 *                          schema: Category, gate: (category) => category.label !== 'spam',
 *                          onGateFail: () => ({ action: 'ignore' }) }),
 *         functionStep({ name: 'enrich', run: async (state) => lookup(state.context) }),
 *         agentStep({ name: 'answer', agent: contextAgent('writer') }),
 *       ],
 *     });
 *
 * Every step is a node under its name, and the step that ends the run writes
 * the result, so the graph view shows `classify → enrich → answer`, with a
 * gated step's early exit as a conditional edge to the end. An `agentStep`
 * declares its participant's graph, so the graph view expands it.
 */

/** A step's output: its text, plus the parsed value when the step produced structured data. */
const StepOutput = z.object({ text: z.string(), value: z.unknown().optional() });
export type StepOutput = z.infer<typeof StepOutput>;

const PipelineInput = new StateSchema({
  messages: MessagesValue,
  /** Structured input for function steps; models only see it through custom prompts. */
  context: z.record(z.string(), z.json()).optional(),
});

const PipelineState = new StateSchema({
  ...PipelineInput.fields,
  structuredResponse: z.unknown().optional(),
  outputs: new ReducedValue(
    z.record(z.string(), StepOutput).default(() => ({})),
    {
      reducer: (current, next) => ({ ...current, ...next }),
    },
  ),
  /** The step whose gate stopped the pipeline. */
  stoppedAt: z.string().optional(),
  fallback: StepOutput.optional(),
});

export type PipelineState = typeof PipelineState.State;

/** What a step records: its output, and when its gate stopped the pipeline, where and with which fallback. */
type StepUpdate = {
  readonly outputs: Readonly<Record<string, StepOutput>>;
  readonly stoppedAt?: string;
  readonly fallback?: StepOutput;
};

export type PipelineStep = {
  readonly name: string;
  readonly gated: boolean;
  readonly run: (state: PipelineState, config: LangGraphRunnableConfig) => Promise<StepUpdate>;
  /** The participant the step runs, drawn as its subgraph. */
  readonly agent?: Agent;
};

type Gate<T, F> = {
  /** Checked on the step's output; `false` stops the pipeline after this step. */
  readonly gate?: (output: T, state: PipelineState) => boolean;
  /** The pipeline's result when the gate stops it. Without one, the stopped step's output is the result. */
  readonly onGateFail?: (output: T, state: PipelineState) => F;
};

type Prompt = {
  /** The user message for this step. Defaults to {@link defaultPrompt}. */
  readonly prompt?: (state: PipelineState) => string;
};

const Text = z.string();

const stepOutput = <T>(value: T): StepOutput => {
  const text = Text.safeParse(value);
  return text.success ? { text: text.data } : { text: toText(value), value };
};

/** The original request followed by every earlier step's output in a `<step name="…">` block. */
export const defaultPrompt = (state: PipelineState): string => {
  const request = state.messages
    .filter((message) => HumanMessage.isInstance(message))
    .map((message) => message.text)
    .join('\n\n');
  const blocks = Object.entries(state.outputs).map(
    ([name, output]) => `<step name="${name}">\n${output.text}\n</step>`,
  );
  return blocks.length === 0 ? request : `${request}\n\nResults of previous steps:\n${blocks.join('\n')}`;
};

const step = <T, F>(
  name: string,
  options: Gate<T, F>,
  produce: (state: PipelineState, config: LangGraphRunnableConfig) => Promise<T>,
  output: (value: T) => StepOutput = stepOutput,
): PipelineStep => ({
  name,
  gated: options.gate !== undefined,
  run: async (state, config) => {
    const value = await produce(state, config);
    const recorded = { outputs: { [name]: output(value) } };
    if (!options.gate || options.gate(value, state)) return recorded;
    const stopped = { ...recorded, stoppedAt: name };
    return options.onGateFail ? { ...stopped, fallback: stepOutput(options.onGateFail(value, state)) } : stopped;
  },
});

const stepMessages = (systemPrompt: string, prompt: string) => [
  new SystemMessage(systemPrompt),
  new HumanMessage(prompt),
];

/** One model call; its text is the step output. */
export const llmStep = <F = never>(
  options: { readonly name: string; readonly model: ModelLike; readonly systemPrompt: string } & Prompt &
    Gate<string, F>,
): PipelineStep => {
  const model = modelResolver(options.model);
  const prompt = options.prompt ?? defaultPrompt;
  return step(options.name, options, async (state, config) => {
    const reply = await (await model(config)).invoke(stepMessages(options.systemPrompt, prompt(state)), config);
    return reply.text;
  });
};

/**
 * One model call with structured output; the parsed value is the step output.
 * `structuredOutputMethod` picks native structured output where the model
 * supports it (see {@link StructuredOutputMethod}).
 */
export const structuredStep = <S extends z.ZodType, F = never>(
  options: {
    readonly name: string;
    readonly model: ModelLike;
    readonly systemPrompt: string;
    readonly schema: S;
    readonly structuredOutputMethod?: StructuredOutputMethod;
  } & Prompt &
    Gate<z.output<S>, F>,
): PipelineStep => {
  const model = modelResolver(options.model);
  const prompt = options.prompt ?? defaultPrompt;
  const method = options.structuredOutputMethod ?? 'auto';
  return step(options.name, options, async (state, config) =>
    structuredCall(
      await model(config),
      options.schema,
      { name: options.name, method },
      stepMessages(options.systemPrompt, prompt(state)),
      config,
    ),
  );
};

/** Runs a participant on `prompt(state)`; its structured response, or else its final text, is the step output. */
export const agentStep = <Structured, F = never>(
  options: { readonly name: string; readonly agent: Agent<Structured> } & Prompt &
    Gate<{ readonly text: string; readonly structured?: Structured | undefined }, F>,
): PipelineStep => {
  const prompt = options.prompt ?? defaultPrompt;
  return {
    ...step(
      options.name,
      options,
      async (state, config) => {
        const result = await options.agent.invoke({ messages: [new HumanMessage(prompt(state))] }, config);
        return { text: finalText(result), structured: result.structuredResponse };
      },
      (result) =>
        result.structured === undefined || result.structured === null
          ? { text: result.text }
          : { text: result.text, value: result.structured },
    ),
    agent: options.agent,
  };
};

/** Deterministic code: retrieval, validation, side effects. Its return value is the step output. */
export const functionStep = <T, F = never>(
  options: { readonly name: string; readonly run: (state: PipelineState) => Promise<T> } & Gate<T, F>,
): PipelineStep => step(options.name, options, options.run);

/**
 * Build the pipeline. Input: `messages`, optional `context`. Output:
 * `messages` with the result appended, `structuredResponse` (the result,
 * when structured), `outputs` of every executed step, and `stoppedAt` when a
 * gate stopped it. `output` picks the result: a step name, a function of the
 * state, or by default the last step that ran. `retryPolicy` retries a step
 * that throws on its own.
 */
export const createPipeline = <R = unknown>(options: {
  readonly steps: ReadonlyArray<PipelineStep>;
  readonly output?: string | ((state: PipelineState) => R);
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
}) => {
  const name = options.name ?? 'pipeline';
  const names = options.steps.map((entry) => entry.name);
  checkNames(names, Object.keys(PipelineState.fields));
  const [first] = names;
  if (first === undefined) throw new Error('A pipeline needs at least one step.');
  const output = options.output;
  const selected = Text.safeParse(output).data;
  if (selected !== undefined && !names.includes(selected)) {
    throw new Error(`Pipeline output '${selected}' is not one of its steps.`);
  }

  const result = (state: PipelineState): StepOutput | undefined => {
    if (state.fallback) return state.fallback;
    if (output instanceof Function) return stepOutput(output(state));
    const executed = names.filter((stepName) => stepName in state.outputs);
    const chosen = selected ?? executed.at(-1);
    return chosen === undefined ? undefined : state.outputs[chosen];
  };

  /**
   * The pipeline's result, from the state with the update of the step that
   * ends the run. Only that step can stop it, so only its fallback counts.
   */
  const finish = (state: PipelineState, update: StepUpdate) => {
    const value = result({ ...state, outputs: { ...state.outputs, ...update.outputs }, fallback: update.fallback });
    return { messages: [answerMessage(value?.text ?? '', name)], structuredResponse: value?.value };
  };

  const Output = new StateSchema({
    messages: MessagesValue,
    structuredResponse: z.custom<R>().optional(),
    outputs: z.record(z.string(), StepOutput),
    stoppedAt: z.string().optional(),
  });
  const builder = new StateGraph({ state: PipelineState, input: PipelineInput, output: Output, nodes: names });
  options.steps.forEach((entry, index) => {
    const next = names[index + 1];
    builder.addNode(
      entry.name,
      async (state: PipelineState, config: LangGraphRunnableConfig) => {
        const update = await entry.run(state, config);
        const ends = next === undefined || update.stoppedAt === entry.name;
        return ends ? { ...update, ...finish(state, update) } : update;
      },
      nodeOptions(options, entry.agent ? [entry.agent] : []),
    );
    const target = next ?? END;
    if (entry.gated) {
      builder.addConditionalEdges(entry.name, (state) => (state.stoppedAt === entry.name ? END : target), [
        ...new Set([target, END]),
      ]);
    } else {
      builder.addEdge(entry.name, target);
    }
  });
  builder.addEdge(START, first);
  return builder.compile(compileOptions(name, options.checkpointer));
};
