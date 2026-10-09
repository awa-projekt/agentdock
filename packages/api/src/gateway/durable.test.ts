import { describe, expect, it } from '@effect/vitest';
import type { WorkflowToolInvocation } from 'agentdock-sdk';
import type { Json } from 'agentdock-sdk/schemas';
import { workflowToolCallsTable } from 'db';
import { eq } from 'drizzle-orm';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { makeTestDb } from '../workflows/test-db';
import { durableCall, SandboxApprovalRequired, type ExecutionToolError, scriptContext } from './durable';

const workflow: WorkflowToolInvocation = {
  workflowId: 'workflow-1',
  runId: 'run-1',
  taskId: 'task-1',
  contextId: 'context-1',
  stepId: 'agent',
};

const code = 'await tools.org_mail_default.send({ to: "a@b.c" })';

describe('durableInvoker', () => {
  it.effect('replays a completed call instead of invoking the tool again', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const calls: Array<string> = [];
      const call = (path: string): Effect.Effect<Json, ExecutionToolError> =>
        Effect.sync(() => {
          calls.push(path);
          return { sent: true };
        });

      const first = yield* durableCall(db)(scriptContext(code, workflow), call)('org_mail_default.send', {
        to: 'a@b.c',
      });
      const replayed = yield* durableCall(db)(scriptContext(code, workflow), call)('org_mail_default.send', {
        to: 'a@b.c',
      });

      expect(first).toEqual({ sent: true });
      expect(replayed).toEqual({ sent: true });
      expect(calls).toEqual(['org_mail_default.send']);
    }),
  );

  it.effect('refuses a replay that calls a different tool at the same dispatch', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const call = (): Effect.Effect<Json, ExecutionToolError> => Effect.succeed(null);

      yield* durableCall(db)(scriptContext(code, workflow), call)('a.one', {});
      const exit = yield* Effect.exit(durableCall(db)(scriptContext(code, workflow), call)('b.two', {}));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect('remembers the approval a frozen call is waiting on', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const request = { actionId: 'apv_1', title: 'Approve org_mail_default.send' };
      const call = (): Effect.Effect<Json, SandboxApprovalRequired> => new SandboxApprovalRequired({ request });

      const exit = yield* Effect.exit(
        durableCall(db)(scriptContext(code, workflow), call)('org_mail_default.send', { to: 'a@b.c' }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const rows = yield* Effect.promise(() =>
        db.select().from(workflowToolCallsTable).where(eq(workflowToolCallsTable.runId, workflow.runId)).all(),
      );
      expect(rows[0]?.status).toBe('pending-approval');
      expect(rows[0]?.approvalId).toBe('apv_1');
    }),
  );

  it.effect('persists nothing outside a workflow run', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const call = (): Effect.Effect<Json, ExecutionToolError> => Effect.succeed({ ok: true });

      const result = yield* durableCall(db)(scriptContext(code, undefined), call)('org_mail_default.send', {});

      expect(result).toEqual({ ok: true });
      expect(yield* Effect.promise(() => db.select().from(workflowToolCallsTable).all())).toEqual([]);
    }),
  );
});
