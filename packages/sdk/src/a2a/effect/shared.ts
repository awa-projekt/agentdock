import { A2AError, ServerCallContext } from '@a2a-js/sdk/server';
import { Extensions, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Effect } from 'effect';
import { type EffectUserBuilder } from './types';

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const errorSummary = (error: unknown): string => {
  if (error instanceof A2AError) {
    return oneLine(`${error.name} code=${error.code} message=${error.message}`);
  }

  if (error instanceof Error) {
    return oneLine(`${error.name}: ${error.message}`);
  }

  if (typeof error === 'string') {
    return oneLine(error);
  }

  try {
    return oneLine(JSON.stringify(error));
  } catch {
    return 'unknown-error';
  }
};

export const logOneLineError = (context: string, error: unknown): void => {
  Effect.runSync(Effect.logError(`${context} ${errorSummary(error)}`));
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

  return HttpServerResponse.setHeader(
    response,
    HTTP_EXTENSION_HEADER,
    context.activatedExtensions.join(','),
  );
};

export const toA2AError = (error: unknown, fallbackMessage: string): A2AError => {
  if (error instanceof A2AError) {
    return error;
  }

  if (error instanceof Error) {
    return A2AError.internalError(error.message);
  }

  return A2AError.internalError(fallbackMessage);
};

export const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value;

export const asJsonRpcId = (body: unknown): unknown => {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const candidate = (body as { id?: unknown }).id;
  return candidate === undefined ? null : candidate;
};

export const parseJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
  invalidMessage = 'Invalid JSON payload.',
) => request.json.pipe(Effect.mapError(() => A2AError.parseError(invalidMessage)));

export const buildContext = Effect.fn('agentdock.a2a.build_context')(function* (
  request: HttpServerRequest.HttpServerRequest,
  userBuilder: EffectUserBuilder,
) {
    const user = yield* Effect.promise(() => userBuilder(request));
    const extensions = Extensions.parseServiceParameter(extensionHeaderFromRequest(request));

    return new ServerCallContext(extensions, user);
  });

export const groupValue = (match: RegExpMatchArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Missing path group at index ${index}`);
  }

  return value;
};
