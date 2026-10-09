import {
  END,
  type LangGraphRunnableConfig,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
import { z } from 'zod';
import {
  type Checkpointer,
  checkNames,
  compileOptions,
  nodeOptions,
  type RetryPolicy,
  type StepTimeout,
} from './core.ts';

/** What a map-reduce runs per item: any runnable, including a whole pattern or workflow graph. */
export type Mapper<Input, Output> = {
  invoke(input: Input, config?: LangGraphRunnableConfig): Promise<Output>;
};

type MapReduceSettings = {
  /** Retries one item's mapping on its own when it throws. */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** Time limit of one attempt of a step that runs an agent or a model (see {@link StepTimeout}). */
  readonly timeout?: StepTimeout | undefined;
  readonly checkpointer?: Checkpointer;
  readonly name?: string;
};

type Reduce<Result, Reduced> = { readonly reduce?: (results: Result[]) => Reduced | Promise<Reduced> };

/** The participant mapped over the items: its name is the mapping node. */
type NamedMapper<Input, Output> = { readonly name: string; readonly agent: Mapper<Input, Output> };

const REDUCE = 'reduce';

/**
 * Maps `mapper` over `items` in parallel (one LangGraph task per item), then
 * reduces. The mapper's node is named after it, so the graph view shows
 * `triage → reduce`. Input `{ items }`, output `{ results, output }`: `results`
 * in item order, `output` = `reduce(results)` (the results by default).
 * `prepare(item)` builds the mapper input, `extract(output)` the per-item
 * result; both default to passing the value through.
 *
 *     createMapReduce({
 *       mapper: { name: 'triage', agent: ticketWorkflow },
 *       prepare: (ticket) => ({ ticket }),
 *       extract: (out) => out.resolution,
 *     });
 */
export function createMapReduce<Item, Output, Reduced = Output[]>(
  options: MapReduceSettings & Reduce<Output, Reduced> & { readonly mapper: NamedMapper<Item, Output> },
): ReturnType<typeof buildMapReduce<Item, Item, Output, Output, Reduced>>;
export function createMapReduce<Item, Input, Output, Reduced = Output[]>(
  options: MapReduceSettings &
    Reduce<Output, Reduced> & { readonly mapper: NamedMapper<Input, Output>; readonly prepare: (item: Item) => Input },
): ReturnType<typeof buildMapReduce<Item, Input, Output, Output, Reduced>>;
export function createMapReduce<Item, Input, Output, Result, Reduced = Result[]>(
  options: MapReduceSettings &
    Reduce<Result, Reduced> & {
      readonly mapper: NamedMapper<Input, Output>;
      readonly prepare: (item: Item) => Input;
      readonly extract: (output: Output) => Result;
    },
): ReturnType<typeof buildMapReduce<Item, Input, Output, Result, Reduced>>;
export function createMapReduce<Value>(
  options: MapReduceSettings &
    Reduce<Value, Value> & {
      readonly mapper: NamedMapper<Value, Value>;
      readonly prepare?: (item: Value) => Value;
      readonly extract?: (output: Value) => Value;
    },
) {
  const pass = (value: Value): Value => value;
  return buildMapReduce<Value, Value, Value, Value, Value>(
    options.mapper,
    options.prepare ?? pass,
    options.extract ?? pass,
    options.reduce,
    options,
  );
}

const buildMapReduce = <Item, Input, Output, Result, Reduced>(
  mapper: NamedMapper<Input, Output>,
  prepare: (item: Item) => Input,
  extract: (output: Output) => Result,
  reduce: ((results: Result[]) => Reduced | Promise<Reduced>) | undefined,
  settings: MapReduceSettings,
) => {
  const Input = new StateSchema({ items: z.array(z.custom<Item>()) });
  const Output = new StateSchema({
    results: z.array(z.custom<Result>()),
    output: z.custom<Reduced | Result[]>(),
  });
  const Mapped = z.object({ index: z.number(), result: z.custom<Result>() });
  const State = new StateSchema({
    ...Input.fields,
    ...Output.fields,
    mapped: new ReducedValue(
      z.array(Mapped).default(() => []),
      {
        reducer: (current, next) => [...current, ...next],
      },
    ),
  });
  /** One item's mapping: its position and the item. */
  const ItemInput = z.object({ index: z.number(), item: z.custom<Item>() });
  checkNames([mapper.name, REDUCE], [...Object.keys(State.fields), ...ItemInput.keyof().options]);

  const reduceNode = async (state: typeof State.State) => {
    const results = [...state.mapped].sort((left, right) => left.index - right.index).map((entry) => entry.result);
    return { results, output: reduce ? await reduce(results) : results };
  };

  const builder = new StateGraph({ state: State, input: Input, output: Output, nodes: [mapper.name, REDUCE] });
  builder.addNode(
    mapper.name,
    async (task: z.infer<typeof ItemInput>, config: LangGraphRunnableConfig) => ({
      mapped: [{ index: task.index, result: extract(await mapper.agent.invoke(prepare(task.item), config)) }],
    }),
    { input: ItemInput, ...nodeOptions(settings, [mapper.agent]) },
  );
  builder.addNode(REDUCE, reduceNode);
  builder.addConditionalEdges(
    START,
    (state) => {
      const sends = state.items.map((item, index) => new Send(mapper.name, { index, item }));
      return sends.length > 0 ? sends : REDUCE;
    },
    [mapper.name, REDUCE],
  );
  builder.addEdge(mapper.name, REDUCE);
  builder.addEdge(REDUCE, END);
  return builder.compile(compileOptions(settings.name ?? 'map_reduce', settings.checkpointer));
};
