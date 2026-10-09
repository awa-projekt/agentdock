import { HumanMessage, SystemMessage } from '@langchain/core/messages';
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
  type Checkpointer,
  catalog,
  checkNames,
  compileOptions,
  invokeAgent,
  nameEnum,
  nodeOptions,
  type Participant,
  type RetryPolicy,
  resultsBlock,
  type StepTimeout,
  WorkResult,
} from './core.ts';
import { type ModelLike, modelResolver, type StructuredOutputMethod, structuredCall, synthesize } from './models.ts';

/**
 * Orchestrator-workers, optionally with re-planning (plan-and-execute). A
 * planner decomposes the request into tasks at run time; tasks run on workers
 * in parallel and the same worker can get several. With `maxRounds > 1` the
 * planner sees every result and may plan another round; an empty plan ends
 * the loop. A synthesizer writes the answer from all results.
 *
 * Every worker is a node named after it; planning and synthesis are the
 * orchestrator's own `plan` and `synthesize` nodes, so the graph view shows
 * `prepare → plan → researcher → plan | synthesize`.
 *
 * Earlier work can be passed in as `results` (a review loop hands the
 * orchestrator its own previous output on a revision): the planner sees it and
 * plans only what is missing, and the synthesizer uses old and new results
 * together. Round numbers continue after the earlier ones; `maxRounds` counts
 * the rounds of one run.
 */

const DEFAULT_PLANNER_PROMPT =
  "You are an orchestrator. Break the user's request into concrete, self-contained tasks and assign " +
  'each task to the most suitable worker.';

const REPLAN_SUFFIX =
  '\n\nYou work in rounds. The results of earlier rounds are shown to you. Plan only the tasks that are ' +
  'still needed; return an empty task list when the request is fully handled.';

const DEFAULT_SYNTHESIZER_PROMPT = "Write the final answer to the user's request based on the work results below.";

/** The `results` of an orchestrator, for a review loop's `carryOver`. */
export const WorkResults = z.array(WorkResult);

const PlannedTask = z.object({ worker: z.string(), instruction: z.string() });

/** A worker's run: its instruction and the round it belongs to. */
const WorkerTask = z.object({ instruction: z.string(), round: z.number() });

const PREPARE = 'prepare';
const PLAN = 'plan';
const SYNTHESIZE = 'synthesize';

export const createOrchestrator = <Answer = never>(options: {
  /** Plans and synthesizes: a chat model, a `provider:model` id or a platform model (`contextModel`). */
  readonly model: ModelLike;
  /** The participants; the planner reads their descriptions. Each is a node under its name. */
  readonly workers: ReadonlyArray<Participant>;
  /** Planning instructions; the worker catalog is appended. */
  readonly plannerPrompt?: string;
  readonly synthesizerPrompt?: string;
  /** Schema of the final answer, returned as `structuredResponse`. */
  readonly responseFormat?: z.ZodType<Answer>;
  /** Planning rounds per run: 1 is classic orchestrator-workers, more enables re-planning. */
  readonly maxRounds?: number;
  /** Cap on fan-out width per round. */
  readonly maxTasksPerRound?: number;
  /** How planning and synthesis produce structured output (`auto`: native where supported). */
  readonly structuredOutputMethod?: StructuredOutputMethod;
  /** Retries the planning, a worker's task or the synthesis on its own when it throws. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
}) => {
  const name = options.name ?? 'orchestrator';
  const names = options.workers.map((worker) => worker.name);
  const model = modelResolver(options.model);
  const method = options.structuredOutputMethod ?? 'auto';
  const maxRounds = options.maxRounds ?? 1;
  const maxTasks = options.maxTasksPerRound ?? 10;
  const Plan = z
    .object({
      tasks: z.array(
        z.object({
          worker: nameEnum(names).describe('Worker that executes the task.'),
          instruction: z.string().describe('Explicit, self-contained instructions.'),
        }),
      ),
    })
    .describe('Tasks for the next round. An empty list means the request is fully handled.');
  const system = `${options.plannerPrompt ?? DEFAULT_PLANNER_PROMPT}\n\nWorkers:\n${catalog(options.workers)}`;

  const Output = new StateSchema({
    messages: MessagesValue,
    structuredResponse: z.custom<Answer>().optional(),
    results: WorkResults.default(() => []),
  });
  const State = new StateSchema({
    ...Output.fields,
    results: new ReducedValue(
      WorkResults.default(() => []),
      {
        reducer: (current, next) => [...current, ...next],
      },
    ),
    round: z.number().default(0),
    /** The round limit of the current run. */
    lastRound: z.number().default(0),
    planned: z.array(PlannedTask).default(() => []),
  });
  type State = typeof State.State;
  checkNames(names, [PREPARE, PLAN, SYNTHESIZE, ...Object.keys(State.fields), ...WorkerTask.keyof().options]);

  /** Per-run bookkeeping: continue the numbering after earlier results and reset the round limit. */
  const prepare = (state: State) => {
    const done = Math.max(0, ...state.results.map((result) => result.round));
    return { round: done, lastRound: done + maxRounds, planned: [] };
  };

  /** Plans the next round, or nothing once the run's rounds are used up. */
  const plan = async (state: State, config: LangGraphRunnableConfig) => {
    if (state.round >= state.lastRound) return { planned: [] };
    const replanning = maxRounds > 1 || state.results.length > 0;
    const messages = [new SystemMessage(system + (replanning ? REPLAN_SUFFIX : '')), ...state.messages];
    if (state.results.length > 0) messages.push(new HumanMessage(resultsBlock(state.results, 'Results so far')));
    const planned = await structuredCall(await model(config), Plan, { name: 'Plan', method }, messages, config);
    return { planned: planned.tasks.slice(0, maxTasks), round: state.round + 1 };
  };

  const assign = (state: State) => {
    const tasks = state.planned.filter((task) => names.includes(task.worker));
    if (tasks.length === 0) return SYNTHESIZE;
    return tasks.map((task) => new Send(task.worker, { instruction: task.instruction, round: state.round }));
  };

  const finish = async (state: State, config: LangGraphRunnableConfig) =>
    synthesize(
      await model(config),
      options.responseFormat,
      method,
      [
        new SystemMessage(options.synthesizerPrompt ?? DEFAULT_SYNTHESIZER_PROMPT),
        ...state.messages,
        new HumanMessage(resultsBlock(state.results, 'Work results')),
      ],
      config,
      name,
    );

  const builder = new StateGraph({
    state: State,
    input: new StateSchema({
      messages: MessagesValue,
      /** Earlier work to build on. */
      results: WorkResults.optional(),
    }),
    output: Output,
    nodes: [PREPARE, PLAN, SYNTHESIZE, ...names],
  });
  builder.addNode(PREPARE, prepare);
  builder.addNode(PLAN, plan, nodeOptions(options));
  builder.addNode(SYNTHESIZE, finish, nodeOptions(options));
  for (const worker of options.workers) {
    builder.addNode(
      worker.name,
      async (task: z.infer<typeof WorkerTask>, config: LangGraphRunnableConfig) => ({
        results: [
          {
            round: task.round,
            worker: worker.name,
            task: task.instruction,
            output: (await invokeAgent(worker, task.instruction, config)).text,
          },
        ],
      }),
      { input: WorkerTask, ...nodeOptions(options, [worker.agent]) },
    );
    // Every worker of a round finishes before the planner runs again, once.
    builder.addEdge(worker.name, PLAN);
  }
  builder.addEdge(START, PREPARE);
  builder.addEdge(PREPARE, PLAN);
  builder.addConditionalEdges(PLAN, assign, [...names, SYNTHESIZE]);
  builder.addEdge(SYNTHESIZE, END);
  return builder.compile(compileOptions(name, options.checkpointer));
};
