import type { JSONRPCResponse } from '@a2a-js/sdk';
import { A2AError, type A2ARequestHandler, JsonRpcTransportHandler } from '@a2a-js/sdk/server';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Option from 'effect/Option';
import type { Json } from '../../schemas/json';
import { currentOtelContext, iterateWithOtelContext, runWithOtelContext } from './otel-context';
import { buildContext, jsonRpcId, logOneLineError, parseJsonBody, toA2AError, withExtensionsHeader } from './shared';
import { formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS, sseTextStream } from './sse';
import type { EffectUserBuilder } from './types';

type JsonRpcHandlerOptions = {
  requestHandler: A2ARequestHandler;
  userBuilder: EffectUserBuilder;
  /**
   * Looks at a request before it is handled; `Some(reason)` refuses it with a
   * 403 JSON-RPC error, e.g. message metadata only some callers may set.
   */
  admit?: (body: Json) => Effect.Effect<Option.Option<string>>;
};

const jsonRpcErrorResponse = (id: Json, error: A2AError) =>
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

const toSseJsonRpcStream = (source: AsyncIterable<JSONRPCResponse>, requestId: Json) =>
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
    let requestId: Json = null;

    const response = yield* Effect.gen(function* () {
      const context = yield* buildContext(request, options.userBuilder);
      const body = yield* parseJsonBody(request);
      requestId = jsonRpcId(body);
      const refusal = options.admit === undefined ? Option.none() : yield* options.admit(body);
      if (Option.isSome(refusal)) {
        return HttpServerResponse.jsonUnsafe(
          { jsonrpc: '2.0', id: requestId, error: A2AError.invalidRequest(refusal.value).toJSONRPCError() },
          { status: 403 },
        );
      }
      yield* Effect.annotateCurrentSpan({
        'http.method': request.method,
        'url.full': request.url,
      });

      const otelCtx = yield* currentOtelContext;
      const result = yield* Effect.tryPromise({
        try: () => runWithOtelContext(otelCtx, () => transportHandler.handle(body, context)),
        catch: (error) => toA2AError(error, 'General processing error.'),
      });

      if (Symbol.asyncIterator in result) {
        const stream = iterateWithOtelContext(otelCtx, result);
        const sseResponse = HttpServerResponse.stream(sseTextStream(toSseJsonRpcStream(stream, requestId)), {
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
        return Effect.succeed(jsonRpcErrorResponse(requestId, toA2AError(error, 'General processing error.')));
      }),
      Effect.withSpan('agentdock.a2a.json_rpc.transport'),
    );

    return response;
  });
};
