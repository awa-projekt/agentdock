import { Runnable } from '@langchain/core/runnables';
import type { Node as DrawableNode } from '@langchain/core/runnables/graph';
import { END, getJsonSchemaFromSchema, START } from '@langchain/langgraph';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type {
  JsonObject,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
} from '../schemas';
import { decodeJsonObjectOption } from '../schemas';
import type { CompiledWorkflow } from './context';

/**
 * Reads what a compiled graph declares about itself: its drawable topology and
 * its input/output JSON Schemas. Node bodies are never inspected and the source
 * is never parsed, so nothing here can claim more than LangGraph itself knows.
 */
export class WorkflowGraphError extends Schema.TaggedError<WorkflowGraphError>()('WorkflowGraphError', {
  message: Schema.String,
}) {}

const nodeKind = (id: string, node: DrawableNode): WorkflowGraphNodeKind => {
  if (id === START) return 'start';
  if (id === END) return 'end';
  return Runnable.isRunnable(node.data) ? 'step' : 'io';
};

/** `Graph#extend` namespaces expanded subgraph nodes as `parent:child`. */
const nodeGroup = (id: string): string | null => {
  const separator = id.lastIndexOf(':');
  return separator === -1 ? null : id.slice(0, separator);
};

export const extractWorkflowGraph = (
  compiled: CompiledWorkflow,
  name: string,
): Effect.Effect<WorkflowGraph, WorkflowGraphError> =>
  Effect.gen(function* () {
    const drawable = yield* Effect.tryPromise({
      // `xray` expands compiled subgraphs in place instead of collapsing them.
      try: () => compiled.getGraphAsync({ xray: true }),
      catch: (error) =>
        new WorkflowGraphError({
          message: `Cannot read the graph of '${name}': ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    const nodes: ReadonlyArray<WorkflowGraphNode> = Object.entries(drawable.nodes).map(([id, node]) => ({
      id,
      name: node.name,
      kind: nodeKind(id, node),
      group: nodeGroup(id),
    }));

    const edges: ReadonlyArray<WorkflowGraphEdge> = drawable.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      conditional: edge.conditional ?? false,
      label: edge.data ?? null,
    }));

    return { nodes, edges };
  });

export type WorkflowContracts = {
  input?: JsonObject;
  output?: JsonObject;
};

/**
 * The input and output JSON Schemas a `StateGraph` declares, when it was built
 * from schemas that can express one (Zod, `StateSchema`). Graphs built from
 * plain `Annotation`s or the functional API declare nothing and return `{}`.
 */
export const extractWorkflowContracts = (compiled: CompiledWorkflow): WorkflowContracts => {
  const input = Option.getOrUndefined(
    decodeJsonObjectOption(getJsonSchemaFromSchema(compiled.builder?._inputRuntimeDefinition)),
  );
  const output = Option.getOrUndefined(
    decodeJsonObjectOption(getJsonSchemaFromSchema(compiled.builder?._outputRuntimeDefinition)),
  );
  const contracts: WorkflowContracts = {};
  if (input) contracts.input = input;
  if (output) contracts.output = output;
  return contracts;
};
