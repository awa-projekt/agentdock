import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { TracesOperationError } from '../traces/schemas';
import { TracesService } from '../traces/service';
import { withHttpRootSpan } from '../tracing';

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const operationError = (fallback: string) => (error: unknown) =>
  Effect.fail(new TracesOperationError({ message: toErrorMessage(error, fallback) }));

export const tracesHandler = HttpApiBuilder.group(AgentdockApi, 'traces', (handlers) =>
  handlers
    .handle('listTraces', ({ query }) =>
      TracesService.use((service) => service.listTraces(query)).pipe(
        withHttpRootSpan('agentdock.http.request.traces.list'),
        Effect.catch(operationError('Failed to list traces')),
      ),
    )
    .handle('getTrace', ({ params }) =>
      TracesService.use((service) => service.getTrace(params.traceId)).pipe(
        withHttpRootSpan('agentdock.http.request.traces.get'),
        Effect.catch(operationError('Failed to fetch trace')),
      ),
    ),
);
