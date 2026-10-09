import {
  AIMessage,
  type BaseMessage,
  type BaseMessageLike,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { END, type LangGraphRunnableConfig, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import {
  type AgentOutput,
  answerMessage,
  type Checkpointer,
  checkNames,
  compileOptions,
  Evaluation,
  finalText,
  MessageValue,
  nodeOptions,
  type Participant,
  type RetryPolicy,
  type StepTimeout,
  taskMessages,
  toMessages,
  toText,
} from './core.ts';
import { type ModelLike, modelResolver, type StructuredOutputMethod, schemaName, structuredCall } from './models.ts';

/**
 * Evaluator-optimizer (reflection loop). A generator produces a candidate, an
 * evaluator grades it, and a failed candidate goes back to the generator with
 * the feedback until one passes or `maxIterations` is hit. Both are nodes
 * named after their role, so the graph view shows `research → review →
 * research | END`:
 *
 *     createEvaluatorOptimizer({
 *       generator: { name: 'research', agent: contextAgent('researcher') },
 *       evaluator: { name: 'review', agent: contextAgent('reviewer', { output: Evaluation }) },
 *     });
 *
 * The evaluator is a participant that returns its verdict as structured
 * response, or a model judge: `{ name, model, prompt }` makes one structured
 * call per review with `prompt` as its rubric.
 *
 * On a revision the generator gets back its own previous output with the
 * feedback appended to its `messages`, plus `evaluation`, the verdict. Patterns
 * build on that: an orchestrator plans only what is missing from its
 * `results`, a parallel with `rerun` runs only the branches the verdict names.
 */

/** What the generator produced: its final text, plus its structured response when it has one. */
export type Candidate<Structured> = { readonly text: string; readonly structured?: Structured | undefined };

/** State keys the loop takes as input, returns and shows the evaluator callbacks, each with its schema. */
export type CarryOver = Readonly<Record<string, z.ZodType>>;

type NoCarryOver = Readonly<Record<never, z.ZodType>>;

type Carried<C extends CarryOver> = { readonly [K in keyof C]?: z.output<C[K]> };

type OptionalFields<C extends CarryOver> = { [K in keyof C]: z.ZodOptional<C[K]> };

/** What the evaluator callbacks see of the loop. */
export type ReviewState<G, E, C extends CarryOver> = {
  /** The loop's input messages: what the candidate answers. */
  readonly request: BaseMessage[];
  readonly candidate: Candidate<G>;
  readonly iterations: number;
  /** The previous verdict, from the second iteration on. */
  readonly evaluation?: E | undefined;
} & Carried<C>;

/** A participant that reviews: it returns the verdict as its structured response. */
export type AgentJudge<E> = Participant<E> & {
  /** Criteria added to the review request, for an agent whose own instructions do not state them. */
  readonly prompt?: string | undefined;
};

/** A model judge: one structured call per review, with `prompt` as its system prompt. */
export type ModelJudge<E> = {
  readonly name: string;
  readonly model: ModelLike;
  /** The rubric. */
  readonly prompt: string;
  /** The verdict schema (default {@link Evaluation}). */
  readonly output?: z.ZodType<E> | undefined;
};

/** A model judge answering with the default {@link Evaluation}. */
type DefaultJudge = ModelJudge<Evaluation> & { readonly output?: undefined };

/** A judge whose verdict type is known: an agent, or a model judge with an `output` schema. */
type TypedJudge<E> = AgentJudge<E> | (ModelJudge<E> & { readonly output: z.ZodType<E> });

export type Judge<E> = AgentJudge<E> | ModelJudge<E>;

const PassedField = z.object({ passed: z.boolean() });
const FeedbackFields = z.object({ feedback: z.string().optional(), issues: z.array(z.string()).optional() });

const defaultPassed = <E>(evaluation: E): boolean => {
  const verdict = PassedField.safeParse(evaluation);
  if (!verdict.success) {
    throw new Error('The verdict has no boolean `passed`; pass `passed` for a custom verdict.');
  }
  return verdict.data.passed;
};

const defaultFeedback = <E>(evaluation: E): string => {
  const fields = FeedbackFields.safeParse(evaluation).data;
  const issues = (fields?.issues ?? []).map((issue) => `- ${issue}`).join('\n');
  return `Reviewer feedback: ${fields?.feedback ?? toText(evaluation)}\n${issues}\nPlease revise your answer accordingly.`;
};

export type EvaluatorOptimizerOptions<G, E, C extends CarryOver> = {
  /** Produces the candidate: a participant, patterns included. Its name is the generating node. */
  readonly generator: Participant<G>;
  /** Grades the candidate: a participant with a structured verdict, or a model judge. Its name is the reviewing node. */
  readonly evaluator: Judge<E>;
  /** Extra material for the evaluator next to the request and the candidate, e.g. the evidence. */
  readonly evaluatorContext?: (state: ReviewState<G, E, C>) => string | BaseMessageLike[] | undefined;
  /** Replaces the request and candidate the evaluator is sent. Excludes `evaluatorContext`. */
  readonly evaluatorInput?: (state: ReviewState<G, E, C>) => string | BaseMessageLike[];
  /**
   * Keys of the generator's output the loop takes as input (handed to the
   * first generation), returns, and shows the evaluator callbacks, e.g.
   * `{ results: WorkResults }`.
   */
  readonly carryOver?: C;
  /** Whether a verdict passes (default: its `passed`). */
  readonly passed?: (evaluation: E) => boolean;
  /** The revision request built from a failed verdict (default: its feedback and issues). */
  readonly feedback?: (evaluation: E) => string;
  /** Cap on generator runs (default 3). */
  readonly maxIterations?: number;
  /**
   * Replaces the candidate when the cap is hit without passing, e.g. to
   * escalate to a human. By default the last candidate is returned; check
   * `evaluation` in the output.
   */
  readonly onMaxIterations?: (candidate: Candidate<G>, evaluation: E) => Candidate<G>;
  /**
   * The generator continues its own conversation, so revisions don't repeat
   * earlier tool calls (default). `false` restarts it from the request, the
   * last candidate and the feedback.
   */
  readonly keepHistory?: boolean;
  /** How a model judge produces the verdict (`auto`: native where supported). */
  readonly structuredOutputMethod?: StructuredOutputMethod;
  /** Retries the generation or the review on its own when it throws, so a failed review does not redo the draft. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
};

const usesDefaultVerdict = <G, E, C extends CarryOver>(
  options:
    | (EvaluatorOptimizerOptions<G, Evaluation, C> & { readonly evaluator: DefaultJudge })
    | (EvaluatorOptimizerOptions<G, E, C> & { readonly evaluator: TypedJudge<E> }),
): options is EvaluatorOptimizerOptions<G, Evaluation, C> & { readonly evaluator: DefaultJudge } =>
  'model' in options.evaluator && options.evaluator.output === undefined;

/**
 * Build a generate → evaluate → revise loop. Nodes: the generator's and the
 * evaluator's names; the evaluator node writes the result when the loop ends.
 * Output: `messages`, `structuredResponse` (a structured candidate),
 * `evaluation`, `iterations`, plus the `carryOver` keys.
 */
export function createEvaluatorOptimizer<G, C extends CarryOver = NoCarryOver>(
  options: EvaluatorOptimizerOptions<G, Evaluation, C> & { readonly evaluator: DefaultJudge },
): EvaluatorOptimizer<G, Evaluation, C>;
/** With an agent judge, or a model judge with its own verdict schema. */
export function createEvaluatorOptimizer<G, E, C extends CarryOver = NoCarryOver>(
  options: EvaluatorOptimizerOptions<G, E, C> & { readonly evaluator: TypedJudge<E> },
): EvaluatorOptimizer<G, E, C>;
export function createEvaluatorOptimizer<G, E, C extends CarryOver>(
  options:
    | (EvaluatorOptimizerOptions<G, Evaluation, C> & { readonly evaluator: DefaultJudge })
    | (EvaluatorOptimizerOptions<G, E, C> & { readonly evaluator: TypedJudge<E> }),
) {
  if (usesDefaultVerdict<G, E, C>(options)) return buildEvaluatorOptimizer(options, Evaluation);
  const evaluator = options.evaluator;
  return buildEvaluatorOptimizer(options, 'model' in evaluator ? evaluator.output : undefined);
}

type EvaluatorOptimizer<G, E, C extends CarryOver> = ReturnType<typeof buildEvaluatorOptimizer<G, E, C>>;

const buildEvaluatorOptimizer = <G, E, C extends CarryOver>(
  options: EvaluatorOptimizerOptions<G, E, C>,
  verdictSchema: z.ZodType<E> | undefined,
) => {
  const name = options.name ?? 'evaluator_optimizer';
  const generator = options.generator;
  const evaluator = options.evaluator;
  const agentJudge: AgentJudge<E> | undefined = 'agent' in evaluator ? evaluator : undefined;
  const judgeModel = 'model' in evaluator ? modelResolver(evaluator.model) : undefined;
  if (generator.name === evaluator.name) {
    throw new Error(
      `The generator and the evaluator are both named '${generator.name}'; they become the loop's nodes, so name them apart.`,
    );
  }
  if (options.evaluatorInput && options.evaluatorContext) {
    throw new Error("evaluatorInput replaces the evaluator's whole input; pass evaluatorContext or it, not both.");
  }
  const carryOver: CarryOver = options.carryOver ?? {};
  const passed = options.passed ?? defaultPassed;
  const feedback = options.feedback ?? defaultFeedback;
  const maxIterations = options.maxIterations ?? 3;
  const keepHistory = options.keepHistory ?? true;
  const method = options.structuredOutputMethod ?? 'auto';

  const looseCarried = Object.fromEntries(Object.entries(carryOver).map(([key, field]) => [key, field.optional()]));
  // SAFETY: built from exactly the entries of `carryOver`, each made optional; typed for the graph's input and output.
  const carriedFields = looseCarried as OptionalFields<C>;
  const CarriedValues = z.object(looseCarried);
  const CandidateValue = z.custom<Candidate<G>>();
  const outputFields = {
    messages: MessagesValue,
    structuredResponse: z.custom<G>().optional(),
    /** The last verdict. */
    evaluation: (verdictSchema ?? z.custom<E>()).optional(),
    iterations: z.number().default(0),
  };
  const State = new StateSchema({
    ...outputFields,
    /** The run's request; cleared when the loop ends. */
    request: z.array(MessageValue).optional(),
    candidate: CandidateValue.optional(),
    /** The generator's last output, handed back on a revision; cleared when the loop ends. */
    generated: z.custom<AgentOutput<G>>().optional(),
    ...looseCarried,
  });
  type State = typeof State.State;
  checkNames([generator.name, evaluator.name], Object.keys(State.fields));

  const finished = (evaluation: E, iterations: number): boolean => passed(evaluation) || iterations >= maxIterations;

  const reviewState = (state: State): ReviewState<G, E, C> => {
    // SAFETY: `CarriedValues` parses exactly the `carryOver` keys with their schemas, which is `Carried<C>`.
    const carried = CarriedValues.parse(state) as Carried<C>;
    return {
      ...carried,
      request: state.request ?? state.messages,
      candidate: state.candidate ?? { text: '' },
      iterations: state.iterations,
      evaluation: state.evaluation,
    };
  };

  /** The revision input: the generator's own last output, its conversation continued with the feedback. */
  const revision = (previous: AgentOutput<G>, evaluation: E, request: BaseMessage[], candidate: Candidate<G>) => {
    const { structuredResponse: _answer, messages: conversation, ...kept } = previous;
    const asked = new HumanMessage(feedback(evaluation));
    const messages = keepHistory
      ? [...toMessages(conversation), asked]
      : [...request, new AIMessage(candidate.text), asked];
    return { ...kept, messages, evaluation };
  };

  const generate = async (state: State, config: LangGraphRunnableConfig) => {
    const previous = state.generated;
    const evaluation = state.evaluation;
    const candidate = state.candidate;
    const revising = previous !== undefined && evaluation !== undefined && candidate !== undefined;
    const request = revising ? (state.request ?? state.messages) : state.messages;
    const input = revising
      ? revision(previous, evaluation, request, candidate)
      : { ...CarriedValues.parse(state), messages: request };
    const result = await generator.agent.invoke(input, config);
    const structured = result.structuredResponse;
    return {
      ...CarriedValues.parse(result),
      request,
      candidate:
        structured === undefined || structured === null
          ? { text: finalText(result) }
          : { text: finalText(result), structured },
      generated: result,
      iterations: revising ? state.iterations + 1 : 1,
    };
  };

  const judgeMessages = (state: State): BaseMessageLike[] => {
    const review = reviewState(state);
    const system = 'model' in evaluator ? [new SystemMessage(evaluator.prompt)] : [];
    if (options.evaluatorInput) return [...system, ...taskMessages(options.evaluatorInput(review))];
    const context = options.evaluatorContext?.(review);
    const contextText = z.string().safeParse(context).data;
    const contextMessages =
      contextText === undefined && context !== undefined && context !== '' ? [context].flat() : [];
    const criteria = agentJudge?.prompt;
    const candidate = review.candidate;
    const parts = [
      ...(criteria === undefined ? [] : [`Review criteria:\n${criteria}`]),
      ...(contextText ? [contextText] : []),
      `Candidate to evaluate:\n${candidate.structured === undefined ? candidate.text : toText(candidate.structured)}`,
    ];
    return [...system, ...review.request, ...contextMessages, new HumanMessage(parts.join('\n\n'))];
  };

  const judge = async (state: State, config: LangGraphRunnableConfig): Promise<E> => {
    const messages = judgeMessages(state);
    if (judgeModel && verdictSchema) {
      const options = { name: schemaName(verdictSchema, 'Evaluation'), method };
      return structuredCall(await judgeModel(config), verdictSchema, options, messages, config);
    }
    const result = await agentJudge?.agent.invoke({ messages }, config);
    const verdict = result?.structuredResponse;
    if (verdict === undefined || verdict === null) {
      throw new Error(
        `The evaluator '${evaluator.name}' returned no structured response; give it an output schema ` +
          "(contextAgent(name, { output }), or createAgent's responseFormat).",
      );
    }
    return verdict;
  };

  /** The loop's result: the last candidate, or what `onMaxIterations` makes of it. */
  const result = (state: State, evaluation: E) => {
    const last = state.candidate ?? { text: '' };
    const candidate = !passed(evaluation) && options.onMaxIterations ? options.onMaxIterations(last, evaluation) : last;
    return { messages: [answerMessage(candidate.text, name)], structuredResponse: candidate.structured };
  };

  const evaluate = async (state: State, config: LangGraphRunnableConfig) => {
    const evaluation = await judge(state, config);
    if (!finished(evaluation, state.iterations)) return { evaluation };
    return { evaluation, ...result(state, evaluation), generated: undefined, request: undefined };
  };

  const builder = new StateGraph({
    state: State,
    input: new StateSchema({ messages: MessagesValue, ...carriedFields }),
    output: new StateSchema({ ...outputFields, ...carriedFields }),
    nodes: [generator.name, evaluator.name],
  });
  builder.addNode(generator.name, generate, nodeOptions(options, [generator.agent]));
  builder.addNode(evaluator.name, evaluate, nodeOptions(options, agentJudge ? [agentJudge.agent] : []));
  builder.addEdge(START, generator.name);
  builder.addEdge(generator.name, evaluator.name);
  builder.addConditionalEdges(
    evaluator.name,
    (state) => (state.evaluation !== undefined && finished(state.evaluation, state.iterations) ? END : generator.name),
    [generator.name, END],
  );
  return builder.compile(compileOptions(name, options.checkpointer));
};
