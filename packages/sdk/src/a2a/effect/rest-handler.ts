import { A2AError, ServerCallContext, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { type MessageSendParams } from '@a2a-js/sdk';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Effect } from 'effect';
import { formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS, sseTextStream } from './sse';
import {
  buildContext,
  groupValue,
  logOneLineError,
  parseJsonBody,
  toA2AError,
  withExtensionsHeader,
} from './shared';
import { type EffectUserBuilder } from './types';

type RestHandlerOptions = {
  requestHandler: A2ARequestHandler;
  userBuilder: EffectUserBuilder;
};

const toRestError = (error: A2AError) => {
  const payload: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };

  if (error.data !== undefined) {
    payload.data = error.data;
  }

  return payload;
};

const mapRestErrorStatus = (error: A2AError): number => {
  if (error.code === -32700 || error.code === -32600 || error.code === -32602) {
    return 400;
  }

  if (error.code === -32601) {
    return 404;
  }

  return 500;
};

const restResponse = (
  context: ServerCallContext,
  status: number,
  body?: unknown,
): HttpServerResponse.HttpServerResponse => {
  const base =
    body === undefined
      ? HttpServerResponse.empty({ status })
      : HttpServerResponse.jsonUnsafe(body, { status });

  return withExtensionsHeader(base, context);
};

const toSseRestStream = (source: AsyncIterable<unknown>) =>
  (async function* () {
    try {
      for await (const event of source) {
        yield formatSSEEvent(event);
      }
    } catch (error) {
      logOneLineError('A2A REST SSE stream error', error);
      const a2aError = toA2AError(error, 'Streaming error.');
      yield formatSSEErrorEvent(toRestError(a2aError));
    }
  })();

const parsePath = (request: HttpServerRequest.HttpServerRequest): string => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname.startsWith('/a2a/rest')) {
    const stripped = pathname.slice('/a2a/rest'.length);
    return stripped.length === 0 ? '/' : stripped;
  }

  return pathname;
};

const notFound = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: 'Not Found',
    },
    {
      status: 404,
    },
  );

export const restHandler = (
  options: RestHandlerOptions,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const context = yield* buildContext(request, options.userBuilder);
    const path = parsePath(request);
    const method = request.method.toUpperCase();
    yield* Effect.annotateCurrentSpan({ 'http.method': method, 'url.full': request.url, 'url.path': path });

    const response = yield* Effect.gen(function* () {
      if (method === 'OPTIONS') {
        return restResponse(context, 204);
      }

      if (method === 'GET' && path === '/v1/card') {
        const card = yield* Effect.tryPromise(() =>
          options.requestHandler.getAuthenticatedExtendedAgentCard(context),
        );
        return restResponse(context, 200, card);
      }

      if (method === 'POST' && path === '/v1/message:send') {
        const body = (yield* parseJsonBody(request)) as unknown as MessageSendParams;
        const result = yield* Effect.tryPromise(() => options.requestHandler.sendMessage(body, context));
        return restResponse(context, 201, result);
      }

      if (method === 'POST' && path === '/v1/message:stream') {
        const body = (yield* parseJsonBody(request)) as unknown as MessageSendParams;
        const stream = yield* Effect.try({
          try: () => options.requestHandler.sendMessageStream(body, context),
          catch: (error) => toA2AError(error, 'Streaming error.'),
        });
        const sseResponse = HttpServerResponse.stream(sseTextStream(toSseRestStream(stream)), {
          status: 200,
          headers: SSE_HEADERS,
        });
        return withExtensionsHeader(sseResponse, context);
      }

      const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskMatch) {
        const taskId = decodeURIComponent(groupValue(taskMatch, 1));
        const searchParams = new URL(request.url, 'http://localhost').searchParams;
        const historyLengthParam = searchParams.get('historyLength') ?? searchParams.get('history_length');
        const historyLength =
          historyLengthParam === null ? undefined : Number.parseInt(historyLengthParam, 10);

        const result = yield* Effect.tryPromise(() =>
          options.requestHandler.getTask(
            historyLength === undefined || Number.isNaN(historyLength)
              ? { id: taskId }
              : { id: taskId, historyLength },
            context,
          ),
        );
        return restResponse(context, 200, result);
      }

      const cancelMatch = path.match(/^\/v1\/tasks\/([^/]+):cancel$/);
      if (method === 'POST' && cancelMatch) {
        const taskId = decodeURIComponent(groupValue(cancelMatch, 1));
        const result = yield* Effect.tryPromise(() => options.requestHandler.cancelTask({ id: taskId }, context));
        return restResponse(context, 202, result);
      }

      const subscribeMatch = path.match(/^\/v1\/tasks\/([^/]+):subscribe$/);
      if (method === 'POST' && subscribeMatch) {
        const taskId = decodeURIComponent(groupValue(subscribeMatch, 1));
        const stream = yield* Effect.try({
          try: () => options.requestHandler.resubscribe({ id: taskId }, context),
          catch: (error) => toA2AError(error, 'Streaming error.'),
        });
        const sseResponse = HttpServerResponse.stream(sseTextStream(toSseRestStream(stream)), {
          status: 200,
          headers: SSE_HEADERS,
        });
        return withExtensionsHeader(sseResponse, context);
      }

      const pushConfigListMatch = path.match(/^\/v1\/tasks\/([^/]+)\/pushNotificationConfigs$/);
      if (method === 'GET' && pushConfigListMatch) {
        const taskId = decodeURIComponent(groupValue(pushConfigListMatch, 1));
        const result = yield* Effect.tryPromise(() =>
          options.requestHandler.listTaskPushNotificationConfigs({ id: taskId }, context),
        );
        return restResponse(context, 200, result);
      }

      if (method === 'POST' && pushConfigListMatch) {
        const taskId = decodeURIComponent(groupValue(pushConfigListMatch, 1));
        const body = (yield* parseJsonBody(request)) as {
          pushNotificationConfig: unknown;
        };

        const result = yield* Effect.tryPromise(() =>
          options.requestHandler.setTaskPushNotificationConfig(
            {
              taskId,
              pushNotificationConfig: body.pushNotificationConfig as never,
            },
            context,
          ),
        );
        return restResponse(context, 201, result);
      }

      const pushConfigMatch = path.match(/^\/v1\/tasks\/([^/]+)\/pushNotificationConfigs\/([^/]+)$/);
      if (method === 'GET' && pushConfigMatch) {
        const taskId = decodeURIComponent(groupValue(pushConfigMatch, 1));
        const configId = decodeURIComponent(groupValue(pushConfigMatch, 2));
        const result = yield* Effect.tryPromise(() =>
          options.requestHandler.getTaskPushNotificationConfig(
            {
              id: taskId,
              pushNotificationConfigId: configId,
            },
            context,
          ),
        );
        return restResponse(context, 200, result);
      }

      if (method === 'DELETE' && pushConfigMatch) {
        const taskId = decodeURIComponent(groupValue(pushConfigMatch, 1));
        const configId = decodeURIComponent(groupValue(pushConfigMatch, 2));
        yield* Effect.tryPromise(() =>
          options.requestHandler.deleteTaskPushNotificationConfig(
            {
              id: taskId,
              pushNotificationConfigId: configId,
            },
            context,
          ),
        );
        return restResponse(context, 204);
      }

      return notFound();
    }).pipe(
      Effect.catch((error) => {
        logOneLineError(`A2A REST handler error ${request.method} ${request.url}`, error);
        const a2aError = toA2AError(error, 'Internal server error');
        return Effect.succeed(restResponse(context, mapRestErrorStatus(a2aError), toRestError(a2aError)));
      }),
      Effect.withSpan('agentdock.a2a.rest.transport'),
    );

    return response;
  });
