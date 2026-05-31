import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { withHttpRootSpan } from '../tracing';

export const generalHandler = HttpApiBuilder.group(AgentdockApi, 'general', (handlers) =>
  handlers.handle('health', () => Effect.succeed('OK').pipe(withHttpRootSpan('agentdock.http.request.health'))),
);
