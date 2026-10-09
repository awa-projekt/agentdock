import { TracesOperationError } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { type TraceFetchError, TracesService } from '../traces/service';
import { withHttpRootSpan } from '../tracing';

const operationError = (error: TraceFetchError) => Effect.fail(new TracesOperationError({ message: error.message }));

export const tracesHandler = HttpApiBuilder.group(AgentdockApi, 'traces', (handlers) =>
  handlers
    .handle('listTraces', ({ query }) =>
      TracesService.use((service) => service.listTraces(query)).pipe(
        withHttpRootSpan('agentdock.http.request.traces.list'),
        Effect.catch(operationError),
      ),
    )
    .handle('getTrace', ({ params, query }) =>
      TracesService.use((service) => service.getTrace(params.traceId, query)).pipe(
        withHttpRootSpan('agentdock.http.request.traces.get'),
        Effect.catch(operationError),
      ),
    ),
);
