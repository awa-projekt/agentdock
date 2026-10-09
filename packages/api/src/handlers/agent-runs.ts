import { AgentRunStore } from 'agentdock-sdk';
import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';

const jsonResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

const toErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/**
 * Single-agent-run lookup (SDK Phase C, C5): every agent run — a2a-originated
 * or workflow-node-originated — is individually inspectable by id through
 * `AgentRunStore`, independent of which surface produced it.
 */
export const agentRunsHandler = HttpApiBuilder.group(AgentdockApi, 'agentRuns', (handlers) =>
  handlers.handle('getAgentRun', ({ params }) =>
    AgentRunStore.use((store) => store.get(params.id)).pipe(
      Effect.map((record) => record ?? jsonResponse(404, 'Agent run not found')),
      withHttpRootSpan('agentdock.http.request.agent_runs.get'),
      Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to get agent run')))),
    ),
  ),
);
