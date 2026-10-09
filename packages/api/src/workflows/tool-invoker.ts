import type { InvocationOutcome, Json } from 'agentdock-sdk/schemas';
import { WorkflowPendingActionId, workflowA2AToolApprovalRequestEnvelope } from 'agentdock-sdk/schemas';
import { WorkflowToolInvokeError, WorkflowToolInvoker } from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { IntegrationCatalog } from '../gateway/catalog';
import { workflowPrincipal } from '../gateway/principals';

const runtimePrincipal = workflowPrincipal('runtime');

const failure = (toolId: string, outcome: Exclude<InvocationOutcome, { status: 'succeeded' | 'pending' }>): string => {
  switch (outcome.status) {
    case 'denied':
      return `Tool '${toolId}' was denied: ${outcome.reason}`;
    case 'failed':
      return `Tool '${toolId}' failed: ${outcome.message}`;
    case 'invalid':
      return `Tool '${toolId}' rejected its arguments: ${outcome.message}`;
    case 'authorization-required':
      return `Tool '${toolId}' acts for a user and cannot run from a workflow`;
  }
};

/**
 * Runs bound workflow tools through the gateway. A call frozen for approval
 * comes back as an input-required result so the workflow can pause on it and
 * collect the outcome once a human decided.
 */
export const WorkflowToolInvokerLive = Layer.effect(
  WorkflowToolInvoker,
  Effect.gen(function* () {
    const catalog = yield* IntegrationCatalog;
    return WorkflowToolInvoker.of({
      invoke: (toolId, input, options) =>
        catalog.invoke(runtimePrincipal, { toolId, input, integrations: options.integrations }).pipe(
          Effect.mapError((error) => new WorkflowToolInvokeError({ message: error.message, error })),
          Effect.flatMap((outcome): Effect.Effect<Json, WorkflowToolInvokeError> => {
            if (outcome.status === 'succeeded') return Effect.succeed(outcome.result);
            if (outcome.status === 'pending') {
              return Effect.succeed({
                status: 'input-required',
                request: workflowA2AToolApprovalRequestEnvelope({
                  actionId: WorkflowPendingActionId.make(outcome.approvalId),
                  title: `Approve ${toolId}`,
                  description: `The workflow wants to call ${toolId}. Approve or decline the call.`,
                  tool: { path: toolId, args: input },
                }),
              });
            }
            return Effect.fail(new WorkflowToolInvokeError({ message: failure(toolId, outcome), error: outcome }));
          }),
        ),
    });
  }),
);
