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
  invokeAgent,
  MessageValue,
  nodeOptions,
  type Participant,
  type RetryPolicy,
  type StepTimeout,
} from './core.ts';

const TALLY = 'tally';

/** One sample: its position, and the conversation the voter is given. */
const SampleTask = z.object({ sample: z.number(), conversation: z.array(MessageValue) });

/**
 * Voting: one participant runs `n` times in parallel and the majority answer
 * wins. The voter's node is named after it, so the graph view shows `classify
 * → tally`. `key` selects what is compared (default: the answer text); ties go
 * to the earliest sample. Use a sampling temperature above 0. Output: the
 * winner's answer and `structuredResponse`, plus `votes` per key.
 */
export const createVoting = <Structured>(options: {
  readonly voter: Participant<Structured>;
  readonly n?: number;
  readonly key?: (result: AgentResult<Structured>) => string;
  /** Retries a sample on its own when it throws. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
}) => {
  const name = options.name ?? 'voting';
  const voter = options.voter;
  const n = options.n ?? 3;
  const key = options.key ?? ((result: AgentResult<Structured>) => result.text);
  const Sample = z.object({ index: z.number(), result: z.custom<AgentResult<Structured>>() });
  const Output = new StateSchema({
    messages: MessagesValue,
    structuredResponse: z.custom<Structured>().optional(),
    votes: z.record(z.string(), z.number()).default(() => ({})),
  });
  const State = new StateSchema({
    ...Output.fields,
    samples: new ReducedValue(
      z.array(Sample).default(() => []),
      {
        reducer: (current, next) => [...current, ...next],
      },
    ),
  });
  checkNames([voter.name, TALLY], [...Object.keys(State.fields), ...SampleTask.keyof().options]);

  const tally = (state: typeof State.State) => {
    const samples = [...state.samples].sort((left, right) => left.index - right.index).map((entry) => entry.result);
    const votes: Record<string, number> = {};
    for (const sample of samples) votes[key(sample)] = (votes[key(sample)] ?? 0) + 1;
    const best = Math.max(0, ...Object.values(votes));
    const winner = samples.find((sample) => votes[key(sample)] === best);
    return { messages: [answerMessage(winner?.text ?? '', name)], votes, structuredResponse: winner?.structured };
  };

  const builder = new StateGraph({
    state: State,
    input: new StateSchema({ messages: MessagesValue }),
    output: Output,
    nodes: [voter.name, TALLY],
  });
  builder.addNode(
    voter.name,
    async (task: z.infer<typeof SampleTask>, config: LangGraphRunnableConfig) => ({
      samples: [{ index: task.sample, result: await invokeAgent(voter, task.conversation, config) }],
    }),
    { input: SampleTask, ...nodeOptions(options, [voter.agent]) },
  );
  builder.addNode(TALLY, tally);
  builder.addConditionalEdges(
    START,
    (state) => Array.from({ length: n }, (_, sample) => new Send(voter.name, { sample, conversation: state.messages })),
    [voter.name],
  );
  builder.addEdge(voter.name, TALLY);
  builder.addEdge(TALLY, END);
  return builder.compile(compileOptions(name, options.checkpointer));
};
