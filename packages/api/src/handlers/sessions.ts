import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { AgentA2aSessionStore } from '../a2a/session-store';
import { SessionOperationError } from '../sessions/schemas';
import { withHttpRootSpan } from '../tracing';

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const operationError = (fallback: string) => (error: unknown) =>
  Effect.fail(new SessionOperationError({ message: toErrorMessage(error, fallback) }));

export const sessionsHandler = HttpApiBuilder.group(AgentdockApi, 'sessions', (handlers) =>
  handlers
    .handle('listEvalSessions', () =>
      AgentA2aSessionStore.use((store) => store.listEvalSessions()).pipe(
        Effect.map((sessions) => ({ sessions })),
        withHttpRootSpan('agentdock.http.request.evals.sessions.list'),
        Effect.catch(operationError('Failed to list eval sessions')),
      ),
    )
    .handle('getEvalSession', ({ params }) =>
      AgentA2aSessionStore.use((store) => store.getEvalSession({ targetId: params.targetId, sessionId: params.sessionId })).pipe(
        withHttpRootSpan('agentdock.http.request.evals.sessions.get'),
        Effect.catch(operationError('Failed to load eval session')),
      ),
    )
    .handle('listSessions', ({ params }) =>
      AgentA2aSessionStore.use((store) => store.listSessions(params.agentId)).pipe(
        Effect.map((sessions) => ({ sessions })),
        withHttpRootSpan('agentdock.http.request.sessions.list'),
        Effect.catch(operationError('Failed to list sessions')),
      ),
    )
    .handle('deleteSession', ({ params }) =>
      AgentA2aSessionStore.use((store) => store.deleteSession({ agentId: params.agentId, sessionId: params.sessionId })).pipe(
        Effect.as({ deleted: true }),
        withHttpRootSpan('agentdock.http.request.sessions.delete'),
        Effect.catch(operationError('Failed to delete session')),
      ),
    ),
);
