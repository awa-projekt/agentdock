import { AgentRunStore } from 'agentdock-sdk';
import { WorkflowRunStore } from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';
import { bindingCandidates } from '../workflows/candidates';
import { WorkflowRegistry } from '../workflows/service';

const jsonResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error,
    },
    { status },
  );

const toErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export const workflowsHandler = HttpApiBuilder.group(AgentdockApi, 'workflows', (handlers) =>
  handlers
    .handle('listWorkflows', () =>
      WorkflowRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.workflows.list'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list workflows')))),
      ),
    )
    .handle('registerWorkflow', ({ payload }) =>
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        return yield* registry.register(payload, yield* bindingCandidates);
      }).pipe(
        withHttpRootSpan('agentdock.http.request.workflows.register'),
        Effect.catchTag('WorkflowRevisionConflictError', (error) => Effect.succeed(jsonResponse(409, error.message))),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(400, toErrorMessage(error, 'Failed to register workflow'))),
        ),
      ),
    )
    .handle('downloadWorkflowArtifact', ({ params }) =>
      WorkflowRegistry.use((registry) => registry.download(params.workflowId)).pipe(
        Effect.map((download) => download ?? jsonResponse(404, 'Workflow not found')),
        withHttpRootSpan('agentdock.http.request.workflows.download'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to download workflow artifact'))),
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
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove workflow')))),
      ),
    )
    .handle('listWorkflowRuns', () =>
      WorkflowRunStore.use((runs) => runs.list()).pipe(
        withHttpRootSpan('agentdock.http.request.workflow_runs.list'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list workflow runs'))),
        ),
      ),
    )
    .handle('getWorkflowRun', ({ params }) =>
      WorkflowRunStore.use((runs) => runs.getSnapshot(params.runId)).pipe(
        Effect.map((snapshot) => snapshot ?? jsonResponse(404, 'Workflow run not found')),
        withHttpRootSpan('agentdock.http.request.workflow_runs.get'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to get workflow run')))),
      ),
    )
    .handle('listWorkflowRunEvents', ({ params }) =>
      WorkflowRunStore.use((runs) => runs.listEvents(params.runId)).pipe(
        Effect.map((events) => events ?? jsonResponse(404, 'Workflow run not found')),
        withHttpRootSpan('agentdock.http.request.workflow_runs.events'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list workflow run events'))),
        ),
      ),
    )
    .handle('listWorkflowRunAgentRuns', ({ params }) =>
      AgentRunStore.use((store) => store.listByWorkflowRun(params.runId)).pipe(
        Effect.map((agentRuns) => ({ agentRuns })),
        withHttpRootSpan('agentdock.http.request.workflow_runs.agent_runs'),
        Effect.catch((error) =>
          Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list workflow run agent runs'))),
        ),
      ),
    ),
);
