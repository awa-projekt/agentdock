import { Extensions, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { A2AError, ServerCallContext } from '@a2a-js/sdk/server';
import * as Effect from 'effect/Effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Predicate from 'effect/Predicate';
import { coerceJson, type Json, jsonProperty, renderJson } from '../../schemas/json';
import type { EffectUserBuilder } from './types';

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const errorSummary = (cause: unknown): string => {
  if (cause instanceof A2AError) {
    return oneLine(`${cause.name} code=${cause.code} message=${cause.message}`);
  }

  if (cause instanceof Error) {
    return oneLine(`${cause.name}: ${cause.message}`);
  }

  if (Predicate.isString(cause)) {
    return oneLine(cause);
  }

  return oneLine(renderJson(coerceJson(cause)));
};

export const logOneLineError = (context: string, cause: unknown): void => {
  Effect.runSync(Effect.logError(`${context} ${errorSummary(cause)}`));
};

const extensionHeaderFromRequest = (request: HttpServerRequest.HttpServerRequest): string | undefined =>
  request.headers[HTTP_EXTENSION_HEADER.toLowerCase()] ?? request.headers[HTTP_EXTENSION_HEADER];

export const withExtensionsHeader = (
  response: HttpServerResponse.HttpServerResponse,
  context: ServerCallContext,
): HttpServerResponse.HttpServerResponse => {
  if (!context.activatedExtensions || context.activatedExtensions.length === 0) {
    return response;
  }

  return HttpServerResponse.setHeader(response, HTTP_EXTENSION_HEADER, context.activatedExtensions.join(','));
};

export const toA2AError = (cause: unknown, fallbackMessage: string): A2AError => {
  if (cause instanceof A2AError) {
    return cause;
  }

  if (cause instanceof Error) {
    return A2AError.internalError(cause.message);
  }

  return A2AError.internalError(fallbackMessage);
};

/** The JSON-RPC `id` to echo back, read from the decoded request body. */
export const jsonRpcId = (body: Json): Json => jsonProperty(body, 'id') ?? null;

/** Reads the request body as JSON; a malformed body becomes an a2a parse error. */
export const parseJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
  invalidMessage = 'Invalid JSON payload.',
): Effect.Effect<Json, A2AError> =>
  request.json.pipe(
    Effect.map(coerceJson),
    Effect.mapError(() => A2AError.parseError(invalidMessage)),
  );

export const buildContext = Effect.fn('agentdock.a2a.build_context')(function* (
  request: HttpServerRequest.HttpServerRequest,
  userBuilder: EffectUserBuilder,
) {
  const user = yield* Effect.promise(() => userBuilder(request));
  const extensions = Extensions.parseServiceParameter(extensionHeaderFromRequest(request));

  return new ServerCallContext(extensions, user);
});
