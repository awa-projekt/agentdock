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
} from './core.ts';
import { type ModelLike, modelResolver, type StructuredOutputMethod, structuredCall, synthesize } from './models.ts';

/**
 * Router: classify once, dispatch to one or more participants in parallel,
 * then merge their answers. Routing is a structured model call (or your own
 * `routeFn`); each selected participant gets a self-contained task.
 *
 *     createRouter({
 *       model: contextModel('router'),
 *       routes: [
 *         { name: 'billing', description: 'Invoices and refunds', agent: contextAgent('billing') },
 *         { name: 'tech', description: 'Errors and outages', agent: contextAgent('tech') },
 *       ],
 *       responseFormat: Answer,
 *     });
 *
 * Every route is a node named after its participant; the routing call and the
 * synthesis are the router's own `route` and `synthesize` nodes, so the graph
 * view shows `route → billing | tech → synthesize`. The router is stateless:
 * a multi-turn chat belongs to a platform agent that calls the workflow.
 */

const DEFAULT_ROUTER_PROMPT =
  "You are a router. Decide which of the available agents should work on the user's request. " +
  'Select every agent that is needed (possibly none) and give each a self-contained task that ' +
  'includes all information it needs.';

const DEFAULT_SYNTHESIZER_PROMPT =
  "Combine the results of the agents below into one coherent, complete answer to the user's request.";

const RouteTask = z.object({ agent: z.string(), task: z.string() });
export type RouteTask = z.infer<typeof RouteTask>;

/** A route's run: the task the router wrote for it. */
const BranchTask = z.object({ task: z.string() });

const ROUTE = 'route';
const SYNTHESIZE = 'synthesize';

export const createRouter = <Answer = never>(options: {
  /** Routes and synthesizes: a chat model, a `provider:model` id or a platform model (`contextModel`). */
  readonly model: ModelLike;
  /** The participants; the router reads their descriptions. Each is a node under its name. */
  readonly routes: ReadonlyArray<Participant>;
  /** Routing instructions; the agent catalog is appended. */
  readonly systemPrompt?: string;
  /** Fan out to several participants (default), or at most one. */
  readonly allowMultiple?: boolean;
  /** Deterministic routing instead of a model call. */
  readonly routeFn?: (state: {
    readonly messages: BaseMessage[];
  }) => ReadonlyArray<RouteTask> | Promise<ReadonlyArray<RouteTask>>;
  readonly synthesizerPrompt?: string;
  /** Schema of the final answer, returned as `structuredResponse`. */
  readonly responseFormat?: z.ZodType<Answer>;
  /**
   * Force (`true`) or skip (`false`) the synthesis call. By default it is
   * skipped when exactly one participant answered and there is no
   * `responseFormat`: that participant's answer is passed through.
   */
  readonly synthesize?: boolean;
  /** How routing and synthesis produce structured output (`auto`: native where supported). */
  readonly structuredOutputMethod?: StructuredOutputMethod;
  /** Retries the routing, a route or the synthesis on its own when it throws. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
}) => {
  const name = options.name ?? 'router';
  const names = options.routes.map((route) => route.name);
  const model = modelResolver(options.model);
  const method = options.structuredOutputMethod ?? 'auto';
  const allowMultiple = options.allowMultiple ?? true;
  const route = z.object({
    agent: nameEnum(names).describe('Name of the agent that should handle this part.'),
    task: z.string().describe('Self-contained task for the agent.'),
  });
  const routes = z.array(route).describe('One entry per selected agent; empty if none is needed.');
  const RoutingDecision = z
    .object({ routes: allowMultiple ? routes : routes.max(1) })
    .describe('Agents that must work on the request (empty list if none).');
  const routerSystem = `${options.systemPrompt ?? DEFAULT_ROUTER_PROMPT}\n\nAvailable agents:\n${catalog(options.routes)}`;

  const Output = new StateSchema({
    messages: MessagesValue,
    structuredResponse: z.custom<Answer>().optional(),
    routes: z.array(RouteTask).default(() => []),
  });
  const State = new StateSchema({
    ...Output.fields,
    routeResults: new ReducedValue(
      z.array(z.custom<AgentResult>()).default(() => []),
      {
        reducer: (current, next) => [...current, ...next],
      },
    ),
  });
  type State = typeof State.State;
  checkNames(names, [ROUTE, SYNTHESIZE, ...Object.keys(State.fields), ...BranchTask.keyof().options]);

  const decide = async (state: State, config: LangGraphRunnableConfig) => {
    const tasks = options.routeFn
      ? await options.routeFn(state)
      : (
          await structuredCall(
            await model(config),
            RoutingDecision,
            { name: 'RoutingDecision', method },
            [new SystemMessage(routerSystem), ...state.messages],
            config,
          )
        ).routes;
    const known = tasks.filter((task) => names.includes(task.agent));
    return { routes: allowMultiple ? known : known.slice(0, 1) };
  };

  const merge = async (state: State, config: LangGraphRunnableConfig) => {
    const results = state.routeResults;
    const [only] = results;
    const skip =
      options.synthesize === undefined ? results.length === 1 && !options.responseFormat : !options.synthesize;
    if (skip && only && results.length === 1) return { messages: [answerMessage(only.text, only.name)] };
    if (skip) {
      return {
        messages: [answerMessage(results.map((result) => `[${result.name}]\n${result.text}`).join('\n\n'), name)],
      };
    }
    return synthesize(
      await model(config),
      options.responseFormat,
      method,
      [
        new SystemMessage(options.synthesizerPrompt ?? DEFAULT_SYNTHESIZER_PROMPT),
        ...state.messages,
        new HumanMessage(resultsBlock(results, 'Results of the agents')),
      ],
      config,
      name,
    );
  };

  const builder = new StateGraph({
    state: State,
    input: new StateSchema({ messages: MessagesValue }),
    output: Output,
    nodes: [ROUTE, SYNTHESIZE, ...names],
  });
  builder.addNode(ROUTE, decide, nodeOptions(options));
  for (const participant of options.routes) {
    builder.addNode(
      participant.name,
      async (input: z.infer<typeof BranchTask>, config: LangGraphRunnableConfig) => ({
        routeResults: [await invokeAgent(participant, input.task, config)],
      }),
      { input: BranchTask, ...nodeOptions(options, [participant.agent]) },
    );
    builder.addEdge(participant.name, SYNTHESIZE);
  }
  builder.addNode(SYNTHESIZE, merge, nodeOptions(options));
  builder.addEdge(START, ROUTE);
  builder.addConditionalEdges(
    ROUTE,
    (state) => {
      const sends = state.routes.map((task) => new Send(task.agent, { task: task.task }));
      return sends.length > 0 ? sends : SYNTHESIZE;
    },
    [...names, SYNTHESIZE],
  );
  builder.addEdge(SYNTHESIZE, END);
  return builder.compile(compileOptions(name, options.checkpointer));
};
