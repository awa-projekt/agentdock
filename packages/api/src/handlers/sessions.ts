import { SessionOperationError } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { type SessionNotFoundError, SessionsService, type SessionsServiceError } from '../sessions/service';
import { withHttpRootSpan } from '../tracing';

const toErrorMessage = (error: SessionsServiceError | SessionNotFoundError, fallback: string): string => {
  if (error._tag === 'SessionNotFoundError') return `Session not found: ${error.sessionId}`;
  return error.cause instanceof Error ? error.cause.message : fallback;
};

const operationError = (fallback: string) => (error: SessionsServiceError | SessionNotFoundError) =>
  Effect.fail(new SessionOperationError({ message: toErrorMessage(error, fallback) }));

export const sessionsHandler = HttpApiBuilder.group(AgentdockApi, 'sessions', (handlers) =>
  handlers
    .handle('listEvalSessions', () =>
      SessionsService.use((store) => store.listEvalSessions()).pipe(
        Effect.map((sessions) => ({ sessions })),
        withHttpRootSpan('agentdock.http.request.evals.sessions.list'),
        Effect.catch(operationError('Failed to list eval sessions')),
      ),
    )
    .handle('getEvalSession', ({ params }) =>
      SessionsService.use((store) =>
        store.getEvalSession({ targetId: params.targetId, sessionId: params.sessionId }),
      ).pipe(
        withHttpRootSpan('agentdock.http.request.evals.sessions.get'),
        Effect.catch(operationError('Failed to load eval session')),
      ),
    )
    .handle('listSessions', ({ params }) =>
      SessionsService.use((store) => store.listChatSessions(params.agentId)).pipe(
        Effect.map((sessions) => ({ sessions })),
        withHttpRootSpan('agentdock.http.request.sessions.list'),
        Effect.catch(operationError('Failed to list sessions')),
      ),
    )
    .handle('deleteSession', ({ params }) =>
      SessionsService.use((store) =>
        store.deleteSession({ targetId: params.agentId, sessionId: params.sessionId }),
      ).pipe(
        Effect.as({ deleted: true }),
        withHttpRootSpan('agentdock.http.request.sessions.delete'),
        Effect.catch(operationError('Failed to delete session')),
      ),
    ),
);
