import type {
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowRunStepProgress,
  WorkflowStepRun,
} from 'agentdock-sdk/schemas';
import { reduceRunProgress } from 'agentdock-sdk/schemas';

/** Live status of a single step, derived from snapshot + event stream. */
export type StepProgress = WorkflowRunStepProgress;

export type RunProgress = {
  readonly runStatus: WorkflowRunStatus;
  readonly steps: ReadonlyMap<string, StepProgress>;
};

export const isTerminalStatus = (status: WorkflowRunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

/** Merge history + live events into a unique, chronologically ordered list. */
export const mergeEvents = (
  ...sources: ReadonlyArray<ReadonlyArray<WorkflowRunEvent>>
): ReadonlyArray<WorkflowRunEvent> => {
  const byId = new Map<string, WorkflowRunEvent>();
  for (const source of sources) {
    for (const event of source) {
      byId.set(event.id, event);
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp),
  );
};

export const reduceProgress = (
  initialRunStatus: WorkflowRunStatus,
  steps: ReadonlyArray<WorkflowStepRun>,
  events: ReadonlyArray<WorkflowRunEvent>,
): RunProgress => reduceRunProgress(initialRunStatus, steps, events);
