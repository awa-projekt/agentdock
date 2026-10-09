import { randomUUIDv4 } from 'agentdock-sdk';
import {
  ApprovalId,
  decodeWorkflowA2AEnvelopeOption,
  WorkflowPendingAction,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunId,
} from 'agentdock-sdk/schemas';
import { WorkflowRunStore, WorkflowRunStoreError } from 'agentdock-sdk/workflows';
import { Database, DatabaseLive } from 'db';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { createWorkflowRunRepo } from '../db/workflow-runs-repo';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { ToolApprovalDecider } from '../gateway/approvals';

const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
const decodePendingAction = Schema.decodeUnknownSync(WorkflowPendingAction);
const decodeEvent = Schema.decodeUnknownSync(WorkflowRunEvent);

const workflowRunIdOf = Schema.decodeUnknownSync(WorkflowRunId);

const runId = Effect.map(randomUUIDv4, (id) => workflowRunIdOf(`wfr_${id.replaceAll('-', '').slice(0, 12)}`));

export const WorkflowRunStoreLive = Layer.effect(
  WorkflowRunStore,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const approvals = yield* ToolApprovalDecider;
    const changes = yield* ChangeFeed;
    const touchesRuns = changes.touches('workflowRuns');
    const repo = createWorkflowRunRepo(db, (cause) => new WorkflowRunStoreError({ cause }));
    // The Clock's synchronous accessor, captured once: run/step rows are plain
    // data assembled inline, and this keeps their timestamps on `TestClock`.
    const clock = yield* Effect.clockWith(Effect.succeed);
    const now = (): string => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
    return WorkflowRunStore.of({
      create: Effect.fn('WorkflowRunStore.create')(function* ({ workflow, taskId, contextId, input }) {
        const id = yield* runId;
        const startedAt = now();
        const run = decodeRun({
          id,
          workflowId: workflow.id,
          taskId,
          contextId,
          status: 'submitted',
          input,
          sourceHash: workflow.sourceHash,
          startedAt,
        });
        return yield* repo.createRun({ workflow, taskId, contextId, value: run });
      }, touchesRuns),
      getWaitingByTask: Effect.fn('WorkflowRunStore.getWaitingByTask')(function* ({ workflowId, taskId, contextId }) {
        return yield* repo.getWaitingByTask({ workflowId, taskId, contextId });
      }),
      createPendingAction: Effect.fn('WorkflowRunStore.createPendingAction')(function* (action) {
        const validated = decodePendingAction(action);
        yield* repo.createPendingAction(validated);
      }, touchesRuns),
      resolvePendingAction: Effect.fn('WorkflowRunStore.resolvePendingAction')(function* ({ actionId, response }) {
        const resolvedAt = now();
        const action = yield* repo.resolvePendingAction({ actionId, response, resolvedAt });
        // A tool approval's action id is the gateway approval; the human's
        // answer decides it there, and the resumed run collects the outcome.
        const envelope = action === null ? Option.none() : decodeWorkflowA2AEnvelopeOption(action.request);
        if (Option.isSome(envelope) && envelope.value.type === 'workflow-tool-approval-request') {
          const decision = response.action === 'decline' || response.action === 'cancel' ? 'decline' : 'accept';
          yield* approvals
            .decideApproval(ApprovalId.make(envelope.value.actionId), decision, 'workflow')
            .pipe(Effect.mapError((cause) => new WorkflowRunStoreError({ cause })));
        }
        return action;
      }, touchesRuns),
      appendEvent: Effect.fn('WorkflowRunStore.appendEvent')(function* (event) {
        const validatedEvent = decodeEvent(event);
        yield* repo.appendEvent(validatedEvent);
      }, touchesRuns),
      append: Effect.fn('WorkflowRunStore.append')(function* (event) {
        const validatedEvent = decodeEvent(event);
        yield* repo.appendEvent(validatedEvent);
      }, touchesRuns),
      list: Effect.fn('WorkflowRunStore.list')(function* () {
        return yield* repo.list();
      }),
      getSnapshot: Effect.fn('WorkflowRunStore.getSnapshot')(function* (id) {
        return yield* repo.getSnapshot(id);
      }),
      listEvents: Effect.fn('WorkflowRunStore.listEvents')(function* (id) {
        return yield* repo.listEvents(id);
      }),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(DatabaseLive, ChangeFeedLive)));
