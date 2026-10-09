import {
  type AgentToolContext,
  type AgentToolSet,
  APPROVE_TOOL_CALL_NAME,
  createApprovalTool,
  createCodeModeTools,
  createNativeIntegrationTools,
  isToolRunFailure,
  ToolRunFailure,
} from 'agentdock-sdk';
import {
  type AgentToolView,
  ApprovalId,
  type ApprovalView,
  coerceJsonObject,
  type InvocationOutcome,
  type Json,
  type JsonObject,
  WorkflowPendingActionId,
  WorkflowRunId,
  workflowA2AToolApprovalRequestEnvelope,
} from 'agentdock-sdk/schemas';
import { Database } from 'db';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { IntegrationCatalog } from './catalog';
import { buildCodeModeDescription, formatExecuteResult, runScript } from './codemode';
import { durableInvoker, ExecutionToolError, SandboxApprovalRequired, scriptContext } from './durable';
import type { IntegrationFailure } from './errors';
import { agentPrincipal } from './principals';

export type AgentToolSetFactoryService = {
  readonly createTools: (
    agentId: string,
    context?: AgentToolContext,
  ) => Effect.Effect<AgentToolSet, IntegrationFailure>;
};

export const AgentToolSetFactory = Context.Service<AgentToolSetFactoryService>('@agentdock/api/AgentToolSetFactory');

const LLM_TOOL_NAME_LIMIT = 64;

const llmToolName = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, LLM_TOOL_NAME_LIMIT);

/**
 * Tool ids are not valid LLM tool names, and two connections of one
 * integration can expose the same tool name. Names are assigned over an
 * id-sorted list so an agent's tool set keeps the same names across turns.
 */
const assignToolNames = (tools: ReadonlyArray<AgentToolView>): ReadonlyArray<readonly [string, AgentToolView]> => {
  const used = new Set<string>();
  return [...tools]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((tool) => {
      const base = llmToolName(`${tool.integration}_${tool.name}`);
      let name = base;
      for (let suffix = 2; used.has(name); suffix += 1) {
        name = `${base.slice(0, LLM_TOOL_NAME_LIMIT - 3)}_${suffix}`;
      }
      used.add(name);
      return [name, tool] as const;
    });
};

/**
 * The approval request as the agent loop expects it: an interrupt payload
 * naming the frozen call, plus the continuation the loop invokes with the
 * human's answer. `collect` says whether that continuation should return the
 * tool's own result (a native call) or just the decision (a script re-runs).
 */
const approvalRequest = (input: {
  readonly approvalId: string;
  readonly toolId: string;
  readonly args: Json;
  readonly context: AgentToolContext | undefined;
  readonly collect: boolean;
}): JsonObject => {
  const workflow = input.context?.workflow;
  const base = {
    actionId: WorkflowPendingActionId.make(input.approvalId),
    title: `Approve ${input.toolId}`,
    description: `The agent wants to call ${input.toolId}. Approve or decline the call.`,
    tool: { path: input.toolId, args: input.args },
  };
  // `runId`/`stepId` are optional keys on the envelope: outside a run their
  // keys have to be absent, not present and undefined, or the decode fails.
  const envelope = workflowA2AToolApprovalRequestEnvelope(
    workflow === undefined ? base : { ...base, runId: WorkflowRunId.make(workflow.runId), stepId: workflow.stepId },
  );
  return {
    ...coerceJsonObject(envelope),
    resume: { toolName: APPROVE_TOOL_CALL_NAME, input: { approvalId: input.approvalId, collect: input.collect } },
  };
};

const authorizationMessage = (
  outcome: Extract<InvocationOutcome, { status: 'authorization-required' }>,
): JsonObject => {
  const message = {
    status: 'authorization-required',
    message: `${outcome.integration} needs the user to connect their own account before this tool can run.`,
  };
  return outcome.session.state.status === 'pending'
    ? { ...message, authorizationUrl: outcome.session.state.authorizationUrl }
    : message;
};

const nativeToolResult = (
  outcome: InvocationOutcome,
  input: { readonly toolId: string; readonly args: Json; readonly context: AgentToolContext | undefined },
): Json => {
  switch (outcome.status) {
    case 'succeeded':
      return outcome.result;
    case 'pending':
      return {
        status: 'input-required',
        request: approvalRequest({ approvalId: outcome.approvalId, collect: true, ...input }),
      };
    case 'denied':
      return { isError: true, error: `The call was denied: ${outcome.reason}` };
    case 'failed':
      return { isError: true, error: outcome.message };
    case 'invalid':
      return {
        isError: true,
        error: outcome.message,
        issues: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`),
      };
    case 'authorization-required':
      return authorizationMessage(outcome);
  }
};

const approvalResult = (approval: ApprovalView): JsonObject => {
  const result = { status: approval.status, approvalId: approval.id, tool: approval.toolId };
  return approval.error === null ? result : { ...result, error: approval.error };
};

export const AgentToolSetFactoryLive = Layer.effect(
  AgentToolSetFactory,
  Effect.gen(function* () {
    const catalog = yield* IntegrationCatalog;
    const { db } = yield* Database;
    const runtimeContext = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(runtimeContext);

    const createTools = Effect.fn('AgentToolSetFactory.createTools')(function* (
      agentId: string,
      context?: AgentToolContext,
    ) {
      const principal = agentPrincipal(agentId);
      const enabled = (yield* catalog.listAgentTools(agentId)).tools.filter((tool) => tool.mode !== 'disabled');
      // A server still unreachable after the gateway's retries ends the run:
      // answered as a tool error, the model would carry on without the data.
      const invoke = (toolId: string, args: Json) =>
        catalog
          .invoke(principal, { toolId, input: args, integrations: context?.integrations })
          .pipe(
            Effect.catchTag('IntegrationUnreachableError', (failure) =>
              Effect.fail(new ToolRunFailure({ message: failure.message })),
            ),
          );

      const native = createNativeIntegrationTools(
        assignToolNames(enabled.filter((tool) => tool.mode === 'native')).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          invoke: (args) =>
            run(
              Effect.map(invoke(tool.id, args), (outcome) =>
                nativeToolResult(outcome, { toolId: tool.id, args, context }),
              ),
            ),
        })),
      );

      const scripted = enabled.filter((tool) => tool.mode === 'codemode');
      const codeMode =
        scripted.length === 0
          ? []
          : createCodeModeTools({
              description: buildCodeModeDescription(scripted),
              execute: ({ code }) =>
                run(
                  Effect.gen(function* () {
                    const script = scriptContext(code, context?.workflow);
                    const invoker = durableInvoker(db)(script, (path, args) =>
                      Effect.gen(function* () {
                        const tool = scripted.find((candidate) => candidate.id === path);
                        if (tool === undefined) {
                          return yield* new ExecutionToolError({ message: `Unknown tool ${path}` });
                        }
                        const outcome = yield* invoke(tool.id, args).pipe(
                          Effect.tapError((failure) =>
                            Effect.sync(() => {
                              if (isToolRunFailure(failure)) script.runFailure = failure;
                            }),
                          ),
                          Effect.mapError((failure) => new ExecutionToolError({ message: failure.message })),
                        );
                        switch (outcome.status) {
                          case 'succeeded':
                            return outcome.result;
                          case 'pending': {
                            const request = approvalRequest({
                              approvalId: outcome.approvalId,
                              toolId: tool.id,
                              args,
                              context,
                              collect: false,
                            });
                            script.inputRequired = request;
                            return yield* new SandboxApprovalRequired({ request });
                          }
                          case 'denied':
                            return yield* new ExecutionToolError({
                              message: `${tool.id} was denied: ${outcome.reason}`,
                            });
                          case 'failed':
                            return yield* new ExecutionToolError({ message: `${tool.id} failed: ${outcome.message}` });
                          case 'invalid':
                            return yield* new ExecutionToolError({
                              message: `${tool.id} rejected the arguments: ${outcome.message}`,
                            });
                          case 'authorization-required':
                            return yield* new ExecutionToolError({
                              message: `${tool.id} needs the user to connect ${outcome.integration} first`,
                            });
                        }
                      }),
                    );
                    const result = yield* runScript(code, invoker).pipe(
                      Effect.map(formatExecuteResult),
                      Effect.catch((failure) => Effect.succeed<JsonObject>({ text: failure.message, isError: true })),
                    );
                    if (script.runFailure !== undefined) return yield* script.runFailure;
                    return script.inputRequired === undefined
                      ? result
                      : { status: 'input-required', request: script.inputRequired };
                  }),
                ),
            });

      const approval = createApprovalTool(({ approvalId, action, collect }) =>
        run(
          Effect.gen(function* () {
            const decided = yield* catalog.decideApproval(ApprovalId.make(approvalId), action, `agent:${agentId}`);
            if (!collect || decided.status !== 'approved') return approvalResult(decided);
            const outcome = yield* invoke(decided.toolId, decided.arguments);
            return nativeToolResult(outcome, { toolId: decided.toolId, args: decided.arguments, context });
          }).pipe(
            Effect.catch((failure) =>
              isToolRunFailure(failure)
                ? Effect.fail(failure)
                : Effect.succeed<Json>({ isError: true, error: failure.message }),
            ),
          ),
        ),
      );

      return [...native, ...codeMode, ...(enabled.length === 0 ? [] : approval)];
    });

    return AgentToolSetFactory.of({ createTools });
  }),
);
