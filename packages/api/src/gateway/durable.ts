import * as NodeCrypto from 'node:crypto';
import type { SandboxToolInvoker } from '@executor-js/codemode-core';
import type { ToolRunFailure, WorkflowToolInvocation } from 'agentdock-sdk';
import { coerceJson, isJsonArray, isJsonObject, type Json, type JsonObject, jsonString } from 'agentdock-sdk/schemas';
import { causeMessage, type DatabaseClient, tryDbWith, workflowToolCallsTable } from 'db';
import { and, eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Data from 'effect/Data';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

/**
 * A `tools.*` call the gateway refused or that failed. The QuickJS runtime
 * only forwards the message of a rejection tagged `ExecutionToolError` into
 * the script; anything else surfaces as "Internal tool error".
 */
export class ExecutionToolError extends Data.TaggedError('ExecutionToolError')<{ readonly message: string }> {}

/** A `tools.*` call froze for approval; the script cannot continue until a human decides. */
export class SandboxApprovalRequired extends Data.TaggedError('SandboxApprovalRequired')<{
  readonly request: JsonObject;
}> {}

export type SandboxToolCall = (
  path: string,
  args: Json,
) => Effect.Effect<Json, ExecutionToolError | SandboxApprovalRequired>;

/**
 * One script execution. The script is re-run on every agent turn, so
 * `dispatchSeq`/`completionSeq` give each `tools.*` call a stable identity
 * across re-runs and its persisted result replays in the original completion
 * order instead of invoking the tool again.
 */
export type ScriptContext = {
  readonly workflow: WorkflowToolInvocation | undefined;
  readonly codeHash: string;
  dispatchSeq: number;
  completionSeq: number;
  nextReplayCompletionSeq: number;
  readonly replayWaiters: Map<number, { readonly result: Json; readonly resolve: (result: Json) => void }>;
  inputRequired: JsonObject | undefined;
  /** A tool call that must end the run, e.g. its server stayed unreachable; the script's own result is moot. */
  runFailure: ToolRunFailure | undefined;
};

export const scriptContext = (code: string, workflow: WorkflowToolInvocation | undefined): ScriptContext => ({
  workflow,
  codeHash: sha256(code),
  dispatchSeq: 0,
  completionSeq: 0,
  nextReplayCompletionSeq: 1,
  replayWaiters: new Map(),
  inputRequired: undefined,
  runFailure: undefined,
});

const canonicalJson = (value: Json): string => {
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): string => NodeCrypto.createHash('sha256').update(value).digest('hex');

const releaseReplayWaiters = (context: ScriptContext): void => {
  while (true) {
    const waiter = context.replayWaiters.get(context.nextReplayCompletionSeq);
    if (!waiter) return;
    context.replayWaiters.delete(context.nextReplayCompletionSeq);
    context.nextReplayCompletionSeq += 1;
    waiter.resolve(waiter.result);
  }
};

const awaitReplayCompletion = (context: ScriptContext, completionSeq: number, result: Json): Effect.Effect<Json> =>
  Effect.promise(
    () =>
      new Promise<Json>((resolve) => {
        context.replayWaiters.set(completionSeq, { result, resolve });
        releaseReplayWaiters(context);
      }),
  );

const approvalIdOf = (request: JsonObject): string | null => jsonString(request, 'actionId') ?? null;

/**
 * Wraps the sandbox tool call so every dispatch inside a workflow run is
 * durable: completed calls replay their persisted result on re-run, a call
 * frozen for approval is remembered, and after the decision the same dispatch
 * collects the outcome from the gateway. Outside a workflow the call passes
 * straight through.
 */
export const durableCall =
  (db: DatabaseClient) =>
  (context: ScriptContext, call: SandboxToolCall): SandboxToolCall => {
    // A ledger write that fails is a failure the script must see; the sandbox
    // can only carry a message, so it arrives as one.
    const tryDb = tryDbWith((cause: unknown) => new ExecutionToolError({ message: causeMessage(cause) }));
    const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => DateTime.formatIso(DateTime.makeUnsafe(millis)));
    return (path, args) =>
      Effect.gen(function* () {
        const argsJson = coerceJson(args);
        const workflow = context.workflow;
        if (workflow === undefined) return yield* call(path, argsJson);

        const dispatchSeq = ++context.dispatchSeq;
        const argsHash = sha256(canonicalJson(argsJson));
        const key = { runId: workflow.runId, stepId: workflow.stepId, codeHash: context.codeHash, dispatchSeq };
        const existing = (yield* tryDb(() =>
          db
            .select()
            .from(workflowToolCallsTable)
            .where(
              and(
                eq(workflowToolCallsTable.runId, key.runId),
                eq(workflowToolCallsTable.stepId, key.stepId),
                eq(workflowToolCallsTable.codeHash, key.codeHash),
                eq(workflowToolCallsTable.dispatchSeq, key.dispatchSeq),
              ),
            )
            .limit(1)
            .all(),
        ))[0];
        if (existing !== undefined) {
          if (existing.path !== path || existing.argsHash !== argsHash) {
            return yield* new ExecutionToolError({
              message: `Non-deterministic replay at tool dispatch ${dispatchSeq}: the script must call the same tools with the same arguments on every run.`,
            });
          }
          if (existing.status === 'completed') {
            return yield* awaitReplayCompletion(context, existing.completionSeq ?? dispatchSeq, existing.result);
          }
        }

        const result = yield* call(path, argsJson).pipe(
          Effect.tapError((failure) =>
            failure._tag !== 'SandboxApprovalRequired'
              ? Effect.void
              : Effect.gen(function* () {
                  const createdAt = yield* nowIso;
                  yield* tryDb(() =>
                    db
                      .insert(workflowToolCallsTable)
                      .values({
                        ...key,
                        path,
                        argsHash,
                        status: 'pending-approval',
                        approvalId: approvalIdOf(failure.request),
                        createdAt,
                      })
                      .onConflictDoNothing()
                      .run(),
                  );
                }),
          ),
        );
        const completionSeq = ++context.completionSeq;
        const completedAt = yield* nowIso;
        yield* tryDb(() =>
          db
            .insert(workflowToolCallsTable)
            .values({
              ...key,
              completionSeq,
              path,
              argsHash,
              status: 'completed',
              result,
              createdAt: completedAt,
              completedAt,
            })
            .onConflictDoUpdate({
              target: [
                workflowToolCallsTable.runId,
                workflowToolCallsTable.stepId,
                workflowToolCallsTable.codeHash,
                workflowToolCallsTable.dispatchSeq,
              ],
              set: { completionSeq, status: 'completed', result, completedAt },
            })
            .run(),
        );
        return result;
      });
  };

/** The sandbox's own invoker, untyped on both sides, over the durable call. */
export const durableInvoker =
  (db: DatabaseClient) =>
  (context: ScriptContext, call: SandboxToolCall): SandboxToolInvoker => {
    const durable = durableCall(db)(context, call);
    return { invoke: ({ path, args }) => durable(path, args === undefined ? {} : coerceJson(args)) };
  };
