import {
  AIMessage,
  type BaseMessage,
  type BaseMessageLike,
  coerceMessageLikeToMessage,
  HumanMessage,
  isBaseMessage,
} from '@langchain/core/messages';
import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
  RetryPolicy,
  StateGraphAddNodeOptions,
  TimeoutPolicy,
} from '@langchain/langgraph';
import { z } from 'zod';

/**
 * The agent contract every pattern speaks: a conversation in, the conversation
 * with the answer appended out, plus the parsed answer when the agent has an
 * output schema. A bound agentdock agent (`contextAgent`), a `createAgent` and
 * every pattern in this package satisfy it, so patterns nest.
 */
export type AgentInput = { readonly messages: BaseMessageLike[] };

export type AgentOutput<Structured = unknown> = {
  readonly messages: BaseMessage[];
  readonly structuredResponse?: Structured | undefined;
};

/** Anything that can be invoked with the agent contract; `Structured` is the type of its parsed answer. */
export interface Agent<Structured = unknown> {
  invoke(input: AgentInput, config?: LangGraphRunnableConfig): Promise<AgentOutput<Structured>>;
}

/**
 * A participant of a pattern: an agent under the name of its role. The name
 * becomes the pattern's graph node, so the graph view shows who does what.
 * Routers and orchestrators read the description to decide whom to involve,
 * so write it for the model there.
 */
export type Participant<Structured = unknown> = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly agent: Agent<Structured>;
};

/** What a pattern keeps of a participant's run. */
export type AgentResult<Structured = unknown> = {
  readonly name: string;
  /** The structured response as JSON, or the text of the last message. */
  readonly text: string;
  /** The participant's parsed answer, when it has an output schema. */
  readonly structured?: Structured | undefined;
  /** The participant's conversation, its answer included. */
  readonly messages: BaseMessage[];
};

/** Retries of a step that runs an agent or a model, when it throws. LangGraph takes one policy per node. */
export type { RetryPolicy };

/**
 * How long one attempt of a step that runs an agent or a model may take: in
 * milliseconds, or as LangGraph's `TimeoutPolicy` (which can also cap idle
 * time). An attempt over it is aborted with `NodeTimeoutError`, which
 * `retryPolicy` retries by default.
 */
export type StepTimeout = number | TimeoutPolicy;

/** The policies of the steps that run an agent or a model. */
export type StepPolicies = {
  readonly retryPolicy?: RetryPolicy | undefined;
  readonly timeout?: StepTimeout | undefined;
};

type NodeOptions = { subgraphs: Subgraph[]; retryPolicy?: RetryPolicy; timeout?: StepTimeout };

/** Checkpoints a pattern graph; only the outermost graph needs one. `false` opts a nested graph out. */
export type Checkpointer = BaseCheckpointSaver | boolean;

/** A compiled graph LangGraph can draw and inspect as a subgraph of the node that calls it. */
export type Subgraph = NonNullable<StateGraphAddNodeOptions['subgraphs']>[number];

export const MessageValue = z.custom<BaseMessage>((value) => isBaseMessage(value));
const Text = z.string();

/** The default verdict of a review: `createEvaluatorOptimizer`'s model judge answers with it. */
export const Evaluation = z
  .object({
    passed: z.boolean().describe('True only if the candidate fully meets all criteria.'),
    score: z.number().min(0).max(1).describe('Quality score between 0 and 1.'),
    issues: z.array(z.string()).describe('Concrete problems to fix.'),
    feedback: z.string().describe('Actionable guidance for the next revision.'),
  })
  .meta({ title: 'Evaluation', description: 'Verdict on a candidate answer.' });
export type Evaluation = z.infer<typeof Evaluation>;

/** One worker run of an orchestrator: the round it ran in, the worker, its task and its answer. */
export const WorkResult = z.object({ round: z.number(), worker: z.string(), task: z.string(), output: z.string() });
export type WorkResult = z.infer<typeof WorkResult>;

/** Plain text for prompts and messages: strings stay as they are, anything else becomes JSON. */
export const toText = <T>(value: T): string => {
  if (value === undefined || value === null) return '';
  const text = Text.safeParse(value);
  return text.success ? text.data : JSON.stringify(value);
};

const lastText = (messages: ReadonlyArray<BaseMessage>): string => messages.at(-1)?.text ?? '';

/** The answer of an agent run: its structured response as JSON, or the text of its last message. */
export const finalText = <Structured>(output: AgentOutput<Structured>): string =>
  output.structuredResponse === undefined || output.structuredResponse === null
    ? lastText(output.messages)
    : toText(output.structuredResponse);

/** The answer as the final message of a pattern run. */
export const answerMessage = (text: string, name: string): AIMessage => new AIMessage({ content: text, name });

/** A task as the conversation a participant receives: a string becomes one user message. */
export const taskMessages = (task: string | BaseMessageLike[]): BaseMessageLike[] =>
  Array.isArray(task) ? task : [new HumanMessage(task)];

/** Invoke a participant with a task (a string becomes one user message). */
export const invokeAgent = async <Structured>(
  participant: Participant<Structured>,
  task: string | BaseMessageLike[],
  config?: LangGraphRunnableConfig,
): Promise<AgentResult<Structured>> => {
  const output = await participant.agent.invoke({ messages: taskMessages(task) }, config);
  const text = finalText(output);
  const structured = output.structuredResponse;
  return structured === undefined || structured === null
    ? { name: participant.name, text, messages: output.messages }
    : { name: participant.name, text, structured, messages: output.messages };
};

const BoundAgent = z.custom<Agent>(
  (value) => value instanceof Object && 'invoke' in value && value.invoke instanceof Function,
);

/** The agent the host bound under `name` for this run. */
const boundAgent = (name: string, config: LangGraphRunnableConfig | undefined): Agent => {
  const bound = z.object({ agents: z.object({ [name]: BoundAgent }) }).safeParse(config?.context);
  const agent = bound.success ? bound.data.agents[name] : undefined;
  if (agent === undefined) {
    throw new Error(
      `No agent '${name}' in the runtime context. On agentdock declare it under "agents" in ` +
        `agentdock.workflow.json; locally pass { context: { agents: { ${name} } } } when invoking.`,
    );
  }
  return agent;
};

/** Parses a bound agent's structured response with the schema it was declared with. */
const parseStructured = <Structured>(
  name: string,
  output: z.ZodType<Structured>,
  structured: AgentOutput['structuredResponse'],
): Structured => {
  if (structured === undefined || structured === null) {
    throw new Error(
      `Agent '${name}' returned no structured response, but contextAgent('${name}', { output }) expects one. ` +
        'Give the platform agent an output schema that matches.',
    );
  }
  const parsed = output.safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      `Agent '${name}' returned a structured response that does not match its output schema:\n` +
        z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
};

/**
 * An agent bound by the host, resolved from `config.context.agents[name]` when
 * it is invoked. On agentdock that is the agent the manifest's `agents.<name>`
 * binds; locally pass `{ context: { agents: { [name]: agent } } }` when
 * invoking the graph. Resolution is lazy, so graphs that use it are built once
 * at module scope. It runs on the host, so the graph view shows it as one step.
 *
 * With `output`, the agent's `structuredResponse` is parsed with the schema,
 * so its answer is typed; a missing or mismatching answer fails the step.
 * Only `messages` are forwarded to the bound agent.
 */
export function contextAgent(name: string): Agent;
export function contextAgent<Structured>(
  name: string,
  options: { readonly output: z.ZodType<Structured> },
): Agent<Structured>;
export function contextAgent<Structured>(
  name: string,
  options?: { readonly output: z.ZodType<Structured> },
): Agent | Agent<Structured> {
  const output = options?.output;
  if (output === undefined) {
    return { invoke: (input, config) => boundAgent(name, config).invoke({ messages: input.messages }, config) };
  }
  return {
    invoke: async (input, config) => {
      const result = await boundAgent(name, config).invoke({ messages: input.messages }, config);
      return {
        messages: result.messages,
        structuredResponse: parseStructured(name, output, result.structuredResponse),
      };
    },
  };
}

const PregelGraph = z.custom<Subgraph>(
  (value) => value instanceof Object && 'lg_is_pregel' in value && value.lg_is_pregel === true,
);
const WrappedGraph = z.object({ graph: PregelGraph });

/**
 * The compiled graph behind a participant: the graph itself, or a
 * `createAgent` agent's `.graph`. Patterns declare it as the subgraph of the
 * node that calls the participant, so `getGraphAsync({ xray: true })` draws its
 * steps and `getState(config, { subgraphs: true })` shows its state. A
 * participant resolved at run time (`contextAgent`) has none.
 */
export const agentGraph = <Runnable>(agent: Runnable): Subgraph | undefined => {
  const direct = PregelGraph.safeParse(agent);
  if (direct.success) return direct.data;
  const wrapped = WrappedGraph.safeParse(agent);
  return wrapped.success ? wrapped.data.graph : undefined;
};

/** `addNode` options for a step that calls `participants` (drawn as its subgraphs), under `policies`. */
export const nodeOptions = <Runnable>(
  policies: StepPolicies,
  participants: ReadonlyArray<Runnable> = [],
): NodeOptions => {
  const options: NodeOptions = { subgraphs: participants.flatMap((participant) => agentGraph(participant) ?? []) };
  if (policies.retryPolicy !== undefined) options.retryPolicy = policies.retryPolicy;
  if (policies.timeout !== undefined) options.timeout = policies.timeout;
  return options;
};

/** `compile` options: the graph name, and the checkpointer when one is given. */
export const compileOptions = (
  name: string,
  checkpointer: Checkpointer | undefined,
): { name: string; checkpointer?: Checkpointer } => (checkpointer === undefined ? { name } : { name, checkpointer });

type MessagesState = { readonly messages: ReadonlyArray<BaseMessageLike> };
type LastMessage = { messages: BaseMessage[] };

const defaultInput = (state: MessagesState): AgentInput => ({ messages: [...state.messages] });
const defaultOutput = <Structured>(result: AgentOutput<Structured>): LastMessage => ({
  messages: result.messages.slice(-1),
});

type AgentNode<State, Update> = (state: State, config: LangGraphRunnableConfig) => Promise<Update>;

/**
 * Adapt a participant to a graph whose state is not the agent contract:
 * `input(state)` builds the conversation, `output(result, state)` the update.
 * The defaults pass `messages` in and append the answer's last message.
 *
 * The node calls the participant with its own config, so it runs as a
 * subgraph (checkpoints, interrupts, streaming). To also draw its steps, pass
 * the participant's graph when adding the node:
 * `addNode('desk', agentAsNode(desk, …), { subgraphs: [desk] })`.
 */
export function agentAsNode<Structured, State, Update>(
  agent: Agent<Structured>,
  options: {
    readonly input: (state: State) => AgentInput;
    readonly output: (result: AgentOutput<Structured>, state: State) => Update;
  },
): AgentNode<State, Update>;
export function agentAsNode<Structured, State>(
  agent: Agent<Structured>,
  options: { readonly input: (state: State) => AgentInput },
): AgentNode<State, LastMessage>;
export function agentAsNode<Structured, State extends MessagesState, Update>(
  agent: Agent<Structured>,
  options: { readonly output: (result: AgentOutput<Structured>, state: State) => Update },
): AgentNode<State, Update>;
export function agentAsNode<Structured, State extends MessagesState>(
  agent: Agent<Structured>,
): AgentNode<State, LastMessage>;
export function agentAsNode<Structured, State extends MessagesState, Update>(
  agent: Agent<Structured>,
  options: {
    readonly input?: (state: State) => AgentInput;
    readonly output?: (result: AgentOutput<Structured>, state: State) => Update | LastMessage;
  } = {},
): AgentNode<State, Update | LastMessage> {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  return async (state, config) => output(await agent.invoke(input(state), config), state);
}

const NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Names become graph nodes: unique, `[A-Za-z0-9_-]`, and none of the
 * pattern's own nodes or state keys (LangGraph cannot tell a node from a state
 * key of the same name).
 */
export const checkNames = (names: ReadonlyArray<string>, reserved: ReadonlyArray<string> = []): void => {
  const invalid = names.filter((name) => !NAME.test(name));
  if (invalid.length > 0) throw new Error(`Names must match [A-Za-z0-9_-]+: ${invalid.join(', ')}`);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) throw new Error(`Names must be unique: ${[...new Set(duplicates)].join(', ')}`);
  const clashes = names.filter((name) => reserved.includes(name));
  if (clashes.length > 0) throw new Error(`Names are reserved by the pattern: ${clashes.join(', ')}`);
};

/** A non-empty tuple for `z.enum`, so structured output constrains the model to known names. */
export const nameEnum = (names: ReadonlyArray<string>) => {
  const [first, ...rest] = names;
  if (first === undefined) throw new Error('A pattern needs at least one participant.');
  return z.enum([first, ...rest]);
};

/** The participants as a catalog for a routing or planning prompt. */
export const catalog = (participants: ReadonlyArray<Pick<Participant, 'name' | 'description'>>): string =>
  participants
    .map((participant) =>
      participant.description === undefined
        ? `- ${participant.name}`
        : `- ${participant.name}: ${participant.description}`,
    )
    .join('\n');

const WorkResults = z.array(WorkResult);
const AgentResultTexts = z.array(z.object({ name: z.string(), text: z.string() }));

/**
 * Render participant results or orchestrator `results` as a prompt block,
 * e.g. for an evaluator's context: `[name]` (or `[worker] (task: …)`) and the
 * answer, one block each.
 */
export const resultsBlock = (
  results: ReadonlyArray<Pick<AgentResult, 'name' | 'text'>> | ReadonlyArray<WorkResult>,
  header = 'Results',
): string => {
  const work = WorkResults.safeParse(results);
  const blocks = work.success
    ? work.data.map((result) => `[${result.worker}] (task: ${result.task})\n${result.output}`)
    : AgentResultTexts.parse(results).map((result) => `[${result.name}]\n${result.text}`);
  return `${header}:\n\n${blocks.length > 0 ? blocks.join('\n\n') : '(none)'}`;
};

/** Coerces message-likes (tuples, dicts) into messages, as LangGraph's `messages` reducer does. */
export const toMessages = (messages: ReadonlyArray<BaseMessageLike>): BaseMessage[] =>
  messages.map((message) => coerceMessageLikeToMessage(message));
