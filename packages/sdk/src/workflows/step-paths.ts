import type { StepRef } from './events';

/**
 * Where a step sits in the graph. LangGraph names the subgraph a task runs in
 * by its namespace, `node:taskId` segments outermost first (`checkpoint_ns`
 * joins them with `|`). Dropping the task ids gives the path the graph view
 * draws an expanded subgraph node under: the node `research` of the subgraph
 * node `team` is `team:research`.
 */
export type NamespaceSegment = { readonly name: string; readonly taskId: string | undefined };

const segment = (value: string): NamespaceSegment => {
  const separator = value.indexOf(':');
  return separator === -1
    ? { name: value, taskId: undefined }
    : { name: value.slice(0, separator), taskId: value.slice(separator + 1) };
};

/** A stream chunk's namespace, as `subgraphs: true` streaming hands it out. */
export const namespaceSegments = (namespace: ReadonlyArray<string>): ReadonlyArray<NamespaceSegment> =>
  namespace.map(segment);

/** A runnable config's `checkpoint_ns`: the same segments, joined by `|`. */
export const checkpointSegments = (checkpointNamespace: string): ReadonlyArray<NamespaceSegment> =>
  checkpointNamespace === '' ? [] : checkpointNamespace.split('|').map(segment);

/** The subgraph nodes a drawn node sits in, outermost first: `a:b` for a node of the group `a:b` is in `a` and `a:b`. */
export const enclosingSteps = (group: string | null): ReadonlyArray<string> =>
  group === null ? [] : group.split(':').map((_, index, names) => names.slice(0, index + 1).join(':'));

export const stepPath = (segments: ReadonlyArray<NamespaceSegment>): string =>
  segments.map((part) => part.name).join(':');

/**
 * The step something running inside `segments` belongs to, innermost first: a
 * prefix of the namespace that is a step (a node the graph view draws, so
 * `team:research` for a node of the subgraph node `team`), or a segment that
 * is a step on its own. The latter is the functional API: its tasks run as
 * steps at the top while the code inside them runs under the entrypoint's
 * namespace (`pipeline:…|ask:…`). The matched segment's task is the execution.
 */
export const stepOfSegments = (
  segments: ReadonlyArray<NamespaceSegment>,
  isStep: (path: string) => boolean,
): StepRef | undefined => {
  for (let length = segments.length; length > 0; length -= 1) {
    const prefix = segments.slice(0, length);
    const innermost = prefix.at(-1);
    const path = stepPath(prefix);
    if (isStep(path)) return { stepId: path, executionId: innermost?.taskId };
    if (innermost !== undefined && isStep(innermost.name)) {
      return { stepId: innermost.name, executionId: innermost.taskId };
    }
  }
  return undefined;
};
