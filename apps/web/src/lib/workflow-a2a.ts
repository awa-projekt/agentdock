import type {
  Message,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { type Client, ClientFactory } from '@a2a-js/sdk/client';
import { randomUUIDv4 } from 'agentdock-sdk/random';
import {
  decodeWorkflowA2AEnvelopeOption,
  type JsonObject,
  type WorkflowA2AHumanInputResponseEnvelope,
  type WorkflowPendingActionId,
  type WorkflowRunEvent,
} from 'agentdock-sdk/schemas';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { listWorkflowRuns, workflowA2aUrl } from '@/lib/api';
import { trackLiveRunEvent } from '@/lib/workflow-run-live';

/** The event union an A2A client stream yields; the SDK keeps the alias internal. */
type StreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

const factory = new ClientFactory();
const clientCache = new Map<string, Promise<Client>>();
const START_TIMEOUT_MS = 15_000;
const START_POLL_INTERVAL_MS = 500;

/** Resolve (and memoize) an A2A client for a workflow's a2a endpoint. */
const workflowClient = (workflowId: string): Promise<Client> => {
  const cached = clientCache.get(workflowId);
  if (cached) {
    return cached;
  }

  // Mirror packages/sdk/src/workflows/nodes/agent.ts: the trailing slash makes the
  // default agent-card path resolve to `${a2aUrl}/.well-known/agent-card.json`.
  const client = factory.createFromUrl(`${workflowA2aUrl(workflowId)}/`);
  clientCache.set(workflowId, client);
  return client;
};

const delay = (millis: number): Promise<void> => Effect.runPromise(Effect.sleep(millis));

const createMessageSendParams = (
  parts: ReadonlyArray<Part>,
  contextId: string,
  taskId?: string,
): MessageSendParams => ({
  configuration: { blocking: false },
  message: {
    kind: 'message',
    contextId,
    taskId,
    messageId: Effect.runSync(randomUUIDv4),
    parts: [...parts],
    role: 'user',
  },
});

const waitForPersistedRun = async (
  workflowId: string,
  contextId: string,
  deadline: number,
): Promise<{ runId: string; taskId: string } | null> => {
  while (Effect.runSync(Clock.currentTimeMillis) < deadline) {
    const run = (await listWorkflowRuns()).find(
      (candidate) => candidate.workflowId === workflowId && candidate.contextId === contextId,
    );
    if (run) {
      return { runId: run.id, taskId: run.taskId };
    }
    await delay(START_POLL_INTERVAL_MS);
  }

  return null;
};

/**
 * Unwrap a workflow event from an A2A stream event. The executor publishes every
 * WorkflowRunEvent as a `status-update` whose message has a `data` part shaped
 * `{ type: 'workflow-event', event }` (see packages/sdk/src/workflows/nodes/types.ts).
 */
const extractWorkflowEvent = (event: StreamEvent): WorkflowRunEvent | null => {
  if (event.kind !== 'status-update') {
    return null;
  }

  for (const part of event.status.message?.parts ?? []) {
    if (part.kind !== 'data') {
      continue;
    }
    const envelope = decodeWorkflowA2AEnvelopeOption(part.data);
    if (Option.isSome(envelope) && envelope.value.type === 'workflow-event') {
      return envelope.value.event;
    }
  }

  return null;
};

/**
 * Kick off a new workflow run via A2A. Resolves as soon as the `run-started`
 * event arrives (carrying the runId + taskId), while the stream keeps draining in
 * the background so the connection is not torn down mid-execution.
 */
export const startWorkflowRun = async (
  workflowId: string,
  parts: ReadonlyArray<Part>,
): Promise<{ runId: string; taskId: string }> => {
  const client = await workflowClient(workflowId);
  const contextId = Effect.runSync(randomUUIDv4);
  const stream = client.sendMessageStream(createMessageSendParams(parts, contextId));
  const deadline = Effect.runSync(Clock.currentTimeMillis) + START_TIMEOUT_MS;

  const fromStream = new Promise<{ runId: string; taskId: string }>((resolve, reject) => {
    void (async () => {
      let started = false;
      try {
        // This connection is opened before the run starts executing, so it is the
        // one path guaranteed to see every workflow event with no gaps — keep
        // draining and tracking it for the run's whole lifetime rather than
        // dropping events once `run-started` has resolved this promise.
        for await (const event of stream) {
          const workflowEvent = extractWorkflowEvent(event);
          if (!workflowEvent) {
            continue;
          }
          trackLiveRunEvent(workflowEvent.runId, workflowEvent);
          if (!started && workflowEvent.type === 'run-started') {
            started = true;
            resolve({ runId: workflowEvent.runId, taskId: workflowEvent.taskId });
          }
        }
        if (!started) {
          reject(new Error('Workflow run did not start.'));
        }
      } catch (error) {
        if (!started) {
          reject(error);
        }
      }
    })();
  });

  const fromStore = waitForPersistedRun(workflowId, contextId, deadline).then((run) => {
    if (!run) {
      throw new Error('Workflow run did not start within 15 seconds. Check the server logs and try again.');
    }
    return run;
  });

  return await Promise.race([fromStream, fromStore]);
};

export const resumeWorkflowRun = async ({
  workflowId,
  taskId,
  contextId,
  actionId,
  response,
  onEvent,
  signal,
}: {
  readonly workflowId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly actionId: WorkflowPendingActionId;
  readonly response: JsonObject;
  readonly onEvent?: (event: WorkflowRunEvent) => void;
  readonly signal?: AbortSignal;
}): Promise<void> => {
  const client = await workflowClient(workflowId);
  const envelope: WorkflowA2AHumanInputResponseEnvelope = {
    type: 'workflow-human-input-response',
    actionId,
    response,
  };
  const stream = client.sendMessageStream(
    createMessageSendParams([{ kind: 'data', data: envelope }], contextId, taskId),
  );

  for await (const event of stream) {
    if (signal?.aborted) {
      return;
    }

    const workflowEvent = extractWorkflowEvent(event);
    if (workflowEvent) {
      onEvent?.(workflowEvent);
    }
  }
};

/**
 * Resubscribe to a live workflow task and yield its workflow events as they
 * stream in. `onEvent` is invoked per event until the stream ends or `signal`
 * aborts. Errors (e.g. the task already finished) are swallowed — history from
 * the REST events endpoint is the source of truth for completed runs.
 */
export const streamWorkflowRun = async (
  workflowId: string,
  taskId: string,
  onEvent: (event: WorkflowRunEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  try {
    const client = await workflowClient(workflowId);
    const stream = client.resubscribeTask({ id: taskId });
    for await (const event of stream) {
      if (signal.aborted) {
        return;
      }

      const workflowEvent = extractWorkflowEvent(event);
      if (workflowEvent) {
        onEvent(workflowEvent);
      }
    }
  } catch {
    // Swallow: resubscribing to an already-terminal task can error; the run
    // history loaded over REST already reflects the final state.
  }
};
