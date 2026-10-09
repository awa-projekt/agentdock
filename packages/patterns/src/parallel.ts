import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  END,
  type LangGraphRunnableConfig,
  MessagesValue,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
import { z } from 'zod';
import {
  type AgentResult,
  answerMessage,
  type Checkpointer,
  checkNames,
  compileOptions,
  Evaluation,
  invokeAgent,
  MessageValue,
  nodeOptions,
  type Participant,
  type RetryPolicy,
  resultsBlock,
  type StepTimeout,
  toText,
} from './core.ts';
import { type ModelLike, modelResolver, type StructuredOutputMethod, synthesize } from './models.ts';

/**
 * Parallelization (sectioning): different participants work on the same
 * request at once, then one node merges their results. Every branch is a
 * node named after its participant, the merge node is named by `merge`, so
 * the graph view shows `billing | tech → merge`.
 *
 * As the generator of an evaluator-optimizer it reworks only what the review
 * found: on a revision it receives its previous `branchResults` and the
 * verdict as `evaluation`, `rerun` names the branches to run again, and the
 * others keep their result.
 *
 *     createParallel({
 *       branches: TEAM.map((name) => ({ name, agent: contextAgent(name, { output: Report }) })),
 *       merge: 'submission',
 *       aggregator: submission,
 *       evaluation: ReviewReport,
 *       rerun: ({ evaluation }) => evaluation.findings.map((finding) => finding.agent),
 *     });
 */

/** The results of a parallel run by branch name. */
export type BranchResults<Structured> = Readonly<Record<string, AgentResult<Structured>>>;

/** What `rerun` decides from: the verdict, the previous results and the revision conversation. */
export type RerunState<Structured, Verdict> = {
  readonly messages: BaseMessage[];
  readonly evaluation: Verdict;
  readonly branchResults: BranchResults<Structured>;
};

/** The structured answer types of a set of participants, as a union. */
type StructuredOf<Branch> = Branch extends Participant<infer Structured> ? Structured : never;

export type ParallelOptions<Branch extends Participant, Answer, Verdict> = {
  /** The participants; each gets the full request and is a node under its name. */
  readonly branches: ReadonlyArray<Branch>;
  /** Name of the node that merges the results (default `merge`). */
  readonly merge?: string;
  /** Merges the results in code; its value is the `structuredResponse`. */
  readonly aggregator?: (
    results: BranchResults<StructuredOf<Branch>>,
    state: { readonly messages: BaseMessage[] },
  ) => Answer | Promise<Answer>;
  /** Merges the results with a synthesis call when there is no `aggregator`. */
  readonly model?: ModelLike;
  readonly synthesizerPrompt?: string;
  /** Schema of the synthesized answer, returned as `structuredResponse`. */
  readonly responseFormat?: z.ZodType<Answer>;
  /** How the synthesizer produces structured output (`auto`: native where supported). */
  readonly structuredOutputMethod?: StructuredOutputMethod;
  /**
   * The branches to run again on a revision, from the verdict (`evaluation`)
   * and the previous `branchResults`. Names that are no branch are ignored; a
   * branch without a previous result always runs.
   */
  readonly rerun?: (state: RerunState<StructuredOf<Branch>, Verdict>) => ReadonlyArray<string>;
  /** Retries a branch or the synthesis on its own when it throws. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
};

const DEFAULT_SYNTHESIZER_PROMPT = "Combine the parallel analyses below into one answer to the user's request.";

/** A branch run: the conversation the branch is given. */
const BranchTask = z.object({ conversation: z.array(MessageValue) });

/**
 * Every branch gets the full request; the merge node waits for all of them.
 * Merging, first match wins: `aggregator` (code), a synthesis call with
 * `model` (structured with `responseFormat`), or the branch answers joined.
 *
 * Input: `messages`, and on a revision the previous `branchResults` and the
 * verdict as `evaluation` (parsed with the `evaluation` schema, default
 * {@link Evaluation}). Then only the branches `rerun` names run, each
 * continuing its own conversation with the revision request (the last of
 * `messages`); without `rerun` every branch does. Output: `messages`,
 * `structuredResponse`, `branchResults` of every branch.
 */
export function createParallel<Branch extends Participant, Answer = never>(
  options: ParallelOptions<Branch, Answer, Evaluation> & { readonly evaluation?: undefined },
): Parallel<Branch, Answer, Evaluation>;
/** With the schema of the verdict `rerun` reads. */
export function createParallel<Branch extends Participant, Answer, Verdict>(
  options: ParallelOptions<Branch, Answer, Verdict> & { readonly evaluation: z.ZodType<Verdict> },
): Parallel<Branch, Answer, Verdict>;
export function createParallel<Branch extends Participant, Answer, Verdict>(
  options:
    | (ParallelOptions<Branch, Answer, Evaluation> & { readonly evaluation?: undefined })
    | (ParallelOptions<Branch, Answer, Verdict> & { readonly evaluation: z.ZodType<Verdict> }),
) {
  return options.evaluation === undefined
    ? buildParallel(options, Evaluation)
    : buildParallel(options, options.evaluation);
}

type Parallel<Branch extends Participant, Answer, Verdict> = ReturnType<typeof buildParallel<Branch, Answer, Verdict>>;

/** Runs a branch on a conversation. */
const runBranch = <Branch extends Participant>(
  branch: Branch,
  conversation: BaseMessage[],
  config: LangGraphRunnableConfig,
): Promise<AgentResult<StructuredOf<Branch>>> =>
  // SAFETY: `Branch` is a `Participant<S>` whose agent answers with `S`, and `StructuredOf<Branch>` infers that `S`.
  invokeAgent(branch as Participant<StructuredOf<Branch>>, conversation, config);

const buildParallel = <Branch extends Participant, Answer, Verdict>(
  options: ParallelOptions<Branch, Answer, Verdict>,
  verdictSchema: z.ZodType<Verdict>,
) => {
  type Structured = StructuredOf<Branch>;
  const name = options.name ?? 'parallel';
  const merge = options.merge ?? 'merge';
  const names = options.branches.map((branch) => branch.name);
  if (names.length === 0) throw new Error('A parallel pattern needs at least one branch.');
  const model = options.model === undefined ? undefined : modelResolver(options.model);
  const method = options.structuredOutputMethod ?? 'auto';
  const rerun = options.rerun;

  const ResultsValue = z.record(z.string(), z.custom<AgentResult<Structured>>());
  const Input = new StateSchema({
    messages: MessagesValue,
    /** The results of the previous run, on a revision. */
    branchResults: ResultsValue.optional(),
    /** The verdict on the previous run, on a revision. */
    evaluation: z.custom<Verdict>().optional(),
  });
  const Output = new StateSchema({
    messages: MessagesValue,
    structuredResponse: z.custom<Answer>().optional(),
    branchResults: ResultsValue,
  });
  const State = new StateSchema({
    ...Output.fields,
    branchResults: new ReducedValue(
      ResultsValue.default(() => ({})),
      {
        reducer: (current, next) => ({ ...current, ...next }),
      },
    ),
    /** Cleared by the merge, so a reused thread does not take its next run for a revision. */
    evaluation: Input.fields.evaluation,
  });
  type State = typeof State.State;
  checkNames([...names, merge], [...Object.keys(State.fields), ...BranchTask.keyof().options]);

  /** The verdict of a revision, parsed with the schema `rerun` reads. */
  const verdict = (evaluation: Verdict): Verdict => {
    const parsed = verdictSchema.safeParse(evaluation);
    if (!parsed.success) {
      throw new Error(
        `The evaluation handed to '${name}' does not match the schema its rerun reads; pass createParallel ` +
          `the evaluator's verdict schema as \`evaluation\`:\n${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  };

  /** The branches to run: all of them, or on a revision those `rerun` names plus any without a result. */
  const targets = (state: State): ReadonlyArray<string> => {
    const previous = state.branchResults;
    if (state.evaluation === undefined || rerun === undefined) return names;
    const named = rerun({ messages: state.messages, evaluation: verdict(state.evaluation), branchResults: previous });
    return names.filter((branch) => named.includes(branch) || previous[branch] === undefined);
  };

  const fanOut = (state: State) => {
    const revisionRequest = state.messages.at(-1);
    const sends = targets(state).map((branch) => {
      const previous = state.branchResults[branch];
      const conversation =
        state.evaluation !== undefined && previous !== undefined && revisionRequest !== undefined
          ? [...previous.messages, revisionRequest]
          : state.messages;
      return new Send(branch, { conversation });
    });
    return sends.length > 0 ? sends : merge;
  };

  const aggregate = async (state: State, config: LangGraphRunnableConfig) => {
    const results = names.flatMap((branch) => state.branchResults[branch] ?? []);
    const cleared = { evaluation: undefined };
    if (options.aggregator) {
      const value = await options.aggregator(state.branchResults, state);
      return { ...cleared, messages: [answerMessage(toText(value), name)], structuredResponse: value };
    }
    if (model) {
      const answer = await synthesize(
        await model(config),
        options.responseFormat,
        method,
        [
          new SystemMessage(options.synthesizerPrompt ?? DEFAULT_SYNTHESIZER_PROMPT),
          ...state.messages,
          new HumanMessage(resultsBlock(results, 'Parallel results')),
        ],
        config,
        name,
      );
      return { ...cleared, ...answer };
    }
    const joined = results.map((result) => `[${result.name}]\n${result.text}`).join('\n\n');
    return { ...cleared, messages: [answerMessage(joined, name)] };
  };

  const builder = new StateGraph({ state: State, input: Input, output: Output, nodes: [merge, ...names] });
  for (const branch of options.branches) {
    builder.addNode(
      branch.name,
      async (task: z.infer<typeof BranchTask>, config: LangGraphRunnableConfig) => ({
        branchResults: { [branch.name]: await runBranch(branch, task.conversation, config) },
      }),
      { input: BranchTask, ...nodeOptions(options, [branch.agent]) },
    );
    builder.addEdge(branch.name, merge);
  }
  builder.addNode(merge, aggregate, nodeOptions(options));
  builder.addConditionalEdges(START, fanOut, [...names, merge]);
  builder.addEdge(merge, END);
  return builder.compile(compileOptions(name, options.checkpointer));
};
