import type { Message, Task } from '@a2a-js/sdk';
import { type ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { AgentLoopFactory, AgentRunStore, AgentToolResolver, ModelProvider, randomUUIDv4 } from 'agentdock-sdk';
import type { Workflow } from 'agentdock-sdk/schemas';
import {
  type ApprovalId,
  type ApprovalView,
  IntegrationToolId,
  WorkflowId,
  WorkflowPendingActionId,
  WorkflowRunId,
  workflowA2AToolApprovalRequestEnvelope,
} from 'agentdock-sdk/schemas';
import {
  loadWorkflowManifest,
  WorkflowRunStore,
  WorkflowTaskExecutor,
  WorkflowToolInvoker,
} from 'agentdock-sdk/workflows';
import { db, langgraphCheckpointsTable, workflowRunsTable } from 'db';
import { eq } from 'drizzle-orm';
import * as Cause from 'effect/Cause';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Queue from 'effect/Queue';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import { ToolApprovalDecider } from '../gateway/approvals';
import { DrizzleLibsqlCheckpointSaver } from './langgraph-checkpointer';
import { WorkflowRunStoreLive } from './runs';

// These tests run against the real (migrated) database with the real WorkflowRunStore,
// the same pattern as runs.test.ts. Unique ids per test isolate the rows. This is the
// closest feasible "full flow": real store + real LangGraph DB checkpointer + real
// executor + real a2a resume. The agent-loop persistence (stage 2) is provided
// separately; stage 3's script replay is covered in executor/durable-tool-calls.test.ts.

// No workflow in these tests calls an agent — the agent services just need to
// satisfy the runtime's uniformly widened Effect requirements.
const agentServicesLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(AgentLoopFactory, AgentLoopFactory.of({ create: () => Effect.die('AgentLoopFactory unused') })),
  Layer.succeed(ModelProvider, ModelProvider.of({ resolve: () => Effect.die('ModelProvider unused') })),
  AgentToolResolver.static([]),
  AgentRunStore.inMemory,
  WorkflowToolInvoker.none,
);
/** No pending action in these tests names a gateway approval, so deciding one is a defect. */
const unusedApprovalDecider = Layer.succeed(
  ToolApprovalDecider,
  ToolApprovalDecider.of({ decideApproval: () => Effect.die('ToolApprovalDecider unused') }),
);
const layer = Layer.mergeAll(WorkflowRunStoreLive.pipe(Layer.provide(unusedApprovalDecider)), agentServicesLayer);

const decidedApproval = (id: ApprovalId): ApprovalView => ({
  id,
  principal: { kind: 'workflow', id: 'workflow-1', name: 'workflow-1' },
  toolId: IntegrationToolId.make('org_email_default.send'),
  alias: 'org_email_default',
  tool: 'send',
  arguments: {},
  status: 'approved',
  createdAt: 0,
  expiresAt: 0,
  decidedAt: 0,
  decidedBy: 'workflow',
  result: null,
  error: null,
});
const noopBus: ExecutionEventBus = {
  publish() {},
  on() {
    return this;
  },
  off() {
    return this;
  },
  once() {
    return this;
  },
  removeAllListeners() {
    return this;
  },
  finished() {},
};

// An artifact that pauses on `interrupt()` and echoes the response, so a
// completed resume can only come from checkpointed state read back out of the DB.
const REVIEW_ENTRYPOINT = `
  import { entrypoint, interrupt, task } from '@langchain/langgraph';
  const done = task('done', async (answer) => JSON.stringify(answer));
  export default entrypoint('review', async () => done(interrupt({ title: 'Review' })));
`;

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodeWorkflowRunId = Schema.decodeUnknownSync(WorkflowRunId);
const decodePendingActionId = Schema.decodeUnknownSync(WorkflowPendingActionId);

const writeArtifact = (prefix: string, entrypoint: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectory({ directory: import.meta.dirname, prefix });
    yield* fs.writeFileString(
      path.join(folder, 'agentdock.workflow.json'),
      encodeJsonString({
        name: 'Review workflow',
        description: 'Review workflow',
        version: '0.1.0',
        graph: './workflow.mjs:default',
        input: { type: 'string' },
      }),
    );
    yield* fs.writeFileString(path.join(folder, 'package.json'), encodeJsonString({ name: 'review', type: 'module' }));
    yield* fs.writeFileString(path.join(folder, 'workflow.mjs'), entrypoint);
    return folder;
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

const removeFolder = (folder: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.remove(folder, { recursive: true, force: true }),
  ).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

const artifactFolder = (prefix: string, entrypoint: string) =>
  Effect.acquireRelease(writeArtifact(prefix, entrypoint), removeFolder);

const reviewWorkflow = (id: string): Effect.Effect<Workflow, never, Scope.Scope> =>
  Effect.gen(function* () {
    const folder = yield* artifactFolder('.tmp-flow-', REVIEW_ENTRYPOINT);
    const loaded = yield* Effect.orDie(loadWorkflowManifest(folder));
    const workflow: Workflow = {
      id: decodeWorkflowId(id),
      source: loaded.folder,
      manifest: loaded.manifest,
      sourceHash: loaded.sourceHash,
      bindings: {},
      revision: 1,
    };
    return workflow;
  });

/**
 * The executor hands work back through a Promise-shaped `run` callback; serving it from a
 * child fiber keeps those effects on the test's own fiber tree and services.
 */
const promiseRunner = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(queue), (effect) => Effect.forkChild(effect))));
  return <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      Queue.offerUnsafe(
        queue,
        Effect.matchCause(effect, {
          onSuccess: resolve,
          onFailure: (cause) => reject(new Error(Cause.pretty(cause))),
        }),
      );
    });
});

describe('workflow checkpointing — full flow on the real store + DB checkpointer', () => {
  it.live('starts, pauses at human-input (persisted), and resumes to completion via a2a on the same taskId', () =>
    Effect.gen(function* () {
      const suffix = yield* randomUUIDv4;
      const workflow = yield* reviewWorkflow(`workflow-${suffix}`);
      const taskId = `task-${suffix}`;
      const contextId = `context-${suffix}`;
      const userMessage: Message = {
        kind: 'message',
        messageId: `msg-${suffix}`,
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      };
      const startContext = new RequestContext(userMessage, taskId, contextId);

      const run = yield* promiseRunner;
      const execute = (context: RequestContext) => {
        const executor = new WorkflowTaskExecutor(workflow, [], {
          checkpointer: new DrizzleLibsqlCheckpointSaver(db),
          run: (effect) => run(effect.pipe(Effect.provide(layer))),
        });
        return Effect.promise(() => executor.execute(context, noopBus));
      };

      // 1) Start → pauses at the human-input node.
      yield* execute(startContext);

      const pausedRun = (yield* Effect.promise(() =>
        db.select().from(workflowRunsTable).where(eq(workflowRunsTable.taskId, taskId)).all(),
      ))[0];
      expect(pausedRun?.status).toBe('input-required');
      // The runtime threads a graph per a2a task, so that is the checkpoint key.
      const checkpointRows = yield* Effect.promise(() =>
        db
          .select()
          .from(langgraphCheckpointsTable)
          .where(eq(langgraphCheckpointsTable.threadId, encodeJsonString([`workflow:${workflow.id}`, taskId])))
          .all(),
      );
      expect(checkpointRows.length).toBeGreaterThan(0);

      // The pending action the UI/a2a client resolves against.
      const snapshot = yield* Effect.gen(function* () {
        const store = yield* WorkflowRunStore;
        return yield* store.getSnapshot(decodeWorkflowRunId(pausedRun!.id));
      }).pipe(Effect.provide(WorkflowRunStoreLive.pipe(Layer.provide(unusedApprovalDecider))));
      const requested = snapshot?.steps
        .flatMap((step) => step.events)
        .find((event) => event.type === 'human-input-requested');
      const actionId = requested?.type === 'human-input-requested' ? requested.actionId : undefined;
      expect(actionId).toBeTruthy();

      // 2) Resume via a2a — same taskId, a data part carrying the human response.
      const pausedTask: Task = { kind: 'task', id: taskId, contextId, status: { state: 'input-required' } };
      const resumeContext = new RequestContext(
        {
          kind: 'message',
          messageId: `resume-${suffix}`,
          role: 'user',
          parts: [
            { kind: 'data', data: { type: 'workflow-human-input-response', actionId, response: { approved: true } } },
          ],
        },
        taskId,
        contextId,
        pausedTask,
      );
      yield* execute(resumeContext);

      const completedRun = (yield* Effect.promise(() =>
        db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, pausedRun!.id)).all(),
      ))[0];
      expect(completedRun?.status).toBe('completed');
      expect(completedRun?.output).toBe('{"approved":true}');
    }),
  );

  it.effect('a2a approval resolution decides the gateway approval the pending action names', () =>
    Effect.gen(function* () {
      const suffix = yield* randomUUIDv4;
      const workflow = yield* reviewWorkflow(`workflow-${suffix}`);
      const actionId = decodePendingActionId(`wfta_${suffix.replaceAll('-', '').slice(0, 12)}`);
      const decisions: Array<{ readonly id: string; readonly action: string; readonly by: string }> = [];
      const recordingDecider = Layer.succeed(
        ToolApprovalDecider,
        ToolApprovalDecider.of({
          decideApproval: (id, action, by) =>
            Effect.sync(() => {
              decisions.push({ id, action, by });
              return decidedApproval(id);
            }),
        }),
      );

      yield* Effect.gen(function* () {
        const store = yield* WorkflowRunStore;
        const run = yield* store.create({
          workflow,
          taskId: `task-${suffix}`,
          contextId: `context-${suffix}`,
          input: 'hi',
        });

        yield* store.createPendingAction({
          id: actionId,
          runId: run.id,
          workflowId: workflow.id,
          taskId: `task-${suffix}`,
          contextId: `context-${suffix}`,
          stepId: 'agent',
          kind: 'human-input',
          status: 'pending',
          request: workflowA2AToolApprovalRequestEnvelope({
            actionId,
            runId: run.id,
            stepId: 'agent',
            title: 'Approve email',
            tool: { path: 'org_email_default.send', args: { to: 'test@example.com' } },
          }),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });

        yield* store.resolvePendingAction({ actionId, response: { action: 'accept' } });
      }).pipe(Effect.provide(WorkflowRunStoreLive.pipe(Layer.provide(recordingDecider))));

      expect(decisions).toEqual([{ id: actionId, action: 'accept', by: 'workflow' }]);
    }),
  );
});
