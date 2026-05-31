import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';
import { WorkflowRegistry } from '../workflows/service';

const jsonResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error,
    },
    { status },
  );

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const workflowsHandler = HttpApiBuilder.group(AgentdockApi, 'workflows', (handlers) =>
  handlers
    .handle('listWorkflows', () =>
      WorkflowRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.workflows.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list workflows'))),
        ),
      ),
    )
    .handle('addWorkflow', ({ payload }) =>
      WorkflowRegistry.use((registry) => registry.add(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.workflows.add'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to add workflow'))),
        ),
      ),
    )
    .handle('updateWorkflow', ({ params, payload }) =>
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        const workflow = yield* registry.update(params.workflowId, payload);

        if (!workflow) {
          return jsonResponse(404, 'Workflow not found');
        }

        return workflow;
      }).pipe(
        withHttpRootSpan('agentdock.http.request.workflows.update'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to update workflow'))),
        ),
      ),
    )
    .handle('removeWorkflow', ({ params }) =>
      WorkflowRegistry.use((registry) => registry.remove(params.workflowId)).pipe(
        Effect.map((removed) => ({ removed })),
        Effect.withSpan('agentdock.http.workflows.remove', {
          attributes: { 'workflow.id': params.workflowId },
        }),
        withHttpRootSpan('agentdock.http.request.workflows.remove'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove workflow'))),
        ),
      ),
    )
);
