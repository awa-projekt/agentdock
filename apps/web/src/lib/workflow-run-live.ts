import type { WorkflowRunEvent } from 'agentdock-sdk/schemas';

type Listener = (event: WorkflowRunEvent) => void;

/**
 * `startWorkflowRun`'s own A2A stream is the one connection guaranteed to see
 * every workflow event from the run's first millisecond onward (it's opened
 * before the workflow starts executing). Resubscribing to the task later
 * (`resubscribeTask`) does NOT replay history, so any node that starts and
 * finishes before a viewer resubscribes would otherwise be lost from the live
 * path entirely. This module lets that originating stream buffer events per
 * run until a viewer (the run details panel) attaches, then delivers them
 * live from that point on — closing the gap without any new backend plumbing.
 */
const buffered = new Map<string, Array<WorkflowRunEvent>>();
const listeners = new Map<string, Set<Listener>>();
const tracked = new Set<string>();

export const trackLiveRunEvent = (runId: string, event: WorkflowRunEvent): void => {
  tracked.add(runId);
  const subscribers = listeners.get(runId);
  if (subscribers && subscribers.size > 0) {
    for (const listener of subscribers) listener(event);
    return;
  }
  const pending = buffered.get(runId) ?? [];
  pending.push(event);
  buffered.set(runId, pending);
};

/** True once this run's originating stream has delivered at least one event in this tab. */
export const hasLiveRunOrigin = (runId: string): boolean => tracked.has(runId);

/** Drain any buffered events into `listener`, then keep delivering future ones until unsubscribed. */
export const subscribeLiveRun = (runId: string, listener: Listener): (() => void) => {
  const pending = buffered.get(runId);
  if (pending) {
    buffered.delete(runId);
    for (const event of pending) listener(event);
  }
  const subscribers = listeners.get(runId) ?? new Set();
  subscribers.add(listener);
  listeners.set(runId, subscribers);
  return () => {
    subscribers.delete(listener);
  };
};
