import { A2AError, JsonRpcTransportHandler, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Effect } from 'effect';
import { formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS, sseTextStream } from './sse';
import {
  asJsonRpcId,
  buildContext,
  isAsyncIterable,
  logOneLineError,
  parseJsonBody,
  toA2AError,
  withExtensionsHeader,
} from './shared';
import { type EffectUserBuilder } from './types';

type JsonRpcHandlerOptions = {
  requestHandler: A2ARequestHandler;
  userBuilder: EffectUserBuilder;
};

const jsonRpcErrorResponse = (id: unknown, error: A2AError) =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: '2.0',
      id,
      error: error.toJSONRPCError(),
    },
    {
      status: error.code === -32700 ? 400 : 500,
    },
  );

const toSseJsonRpcStream = (source: AsyncIterable<unknown>, requestId: unknown) =>
  (async function* () {
    try {
      for await (const event of source) {
        yield formatSSEEvent(event);
      }
    } catch (error) {
      logOneLineError('A2A JSON-RPC SSE stream error', error);
      const a2aError = toA2AError(error, 'Streaming error.');
      const errorResponse = {
        jsonrpc: '2.0',
        id: requestId,
        error: a2aError.toJSONRPCError(),
      };
      yield formatSSEErrorEvent(errorResponse);
    }
  })();

export const jsonRpcHandler = (
  options: JsonRpcHandlerOptions,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> => {
  const transportHandler = new JsonRpcTransportHandler(options.requestHandler);

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    let requestId: unknown = null;

    const response = yield* Effect.gen(function* () {
      const context = yield* buildContext(request, options.userBuilder);
      const body = yield* parseJsonBody(request);
      requestId = asJsonRpcId(body);
      yield* Effect.annotateCurrentSpan({
        'http.method': request.method,
        'url.full': request.url,
      });

      const result = yield* Effect.tryPromise({
        try: () => transportHandler.handle(body, context),
        catch: (error) => toA2AError(error, 'General processing error.'),
      });

      if (isAsyncIterable(result)) {
        const sseResponse = HttpServerResponse.stream(sseTextStream(toSseJsonRpcStream(result, requestId)), {
          status: 200,
          headers: SSE_HEADERS,
        });
        return withExtensionsHeader(sseResponse, context);
      }

      const jsonResponse = HttpServerResponse.jsonUnsafe(result, { status: 200 });
      return withExtensionsHeader(jsonResponse, context);
    }).pipe(
      Effect.catch((error) => {
        logOneLineError(`A2A JSON-RPC handler error ${request.method} ${request.url}`, error);
        return Effect.succeed(
          jsonRpcErrorResponse(requestId, toA2AError(error, 'General processing error.')),
        );
      }),
      Effect.withSpan('agentdock.a2a.json_rpc.transport'),
    );

    return response;
  });
};
