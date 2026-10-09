import { ApiFailure, describeApiFailure, type JsonSerializable } from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { readToken } from './credentials';
import { type CliError, cliError, messageOf } from './errors';
import type { FileServices } from './files';
import { resolveApiBaseUrl } from './project';

export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  status: Schema.Number,
  message: Schema.String,
}) {}

export type ApiMethod = 'GET' | 'POST' | 'PUT';

export type ApiCallOptions = {
  readonly body?: JsonSerializable;
  /** Decode the body with the schema whatever the status, instead of failing on non-2xx. */
  readonly decodeErrorStatus?: boolean;
};

export type ApiService = {
  readonly baseUrl: string;
  readonly call: <S extends Schema.Top>(
    schema: S,
    method: ApiMethod,
    path: string,
    options?: ApiCallOptions,
  ) => Effect.Effect<S['Type'], CliError | ApiError, S['DecodingServices']>;
};

export const Api = Context.Service<ApiService>('@agentdock/cli/Api');

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({ error: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }),
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
const decodeApiFailure = Schema.decodeUnknownOption(Schema.fromJsonString(ApiFailure));

const errorMessageOf = (status: number, text: string): string =>
  Option.match(decodeApiFailure(text), {
    onSome: describeApiFailure,
    onNone: () =>
      Option.match(decodeErrorBody(text), {
        onNone: () => (text.length > 0 ? text : `HTTP ${status}`),
        onSome: (body) => body.error ?? body.message ?? text,
      }),
  });

const makeRequest = (baseUrl: string, method: ApiMethod, path: string, body: JsonSerializable) => {
  const url = new URL(path, `${baseUrl}/`);
  const options = body === undefined ? {} : { body: HttpBody.jsonUnsafe(body) };
  switch (method) {
    case 'GET':
      return HttpClientRequest.get(url, options);
    case 'POST':
      return HttpClientRequest.post(url, options);
    case 'PUT':
      return HttpClientRequest.put(url, options);
  }
};

export const ApiLive: Layer.Layer<ApiService, CliError, HttpClient.HttpClient | FileServices> = Layer.effect(
  Api,
  Effect.gen(function* () {
    const baseUrl = yield* resolveApiBaseUrl;
    const client = yield* HttpClient.HttpClient;
    const services = yield* Effect.context<FileServices>();

    const call: ApiService['call'] = Effect.fn('AgentdockCli.api')(function* (schema, method, path, options) {
      const token = yield* readToken(baseUrl).pipe(Effect.provideContext(services));
      const request = makeRequest(baseUrl, method, path, options?.body).pipe((req) =>
        token === undefined ? req : HttpClientRequest.bearerToken(req, token),
      );
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((error) => cliError(`Cannot reach ${baseUrl}: ${messageOf(error)}`)));
      const ok = response.status >= 200 && response.status < 300;
      if (!ok && !options?.decodeErrorStatus) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
        return yield* new ApiError({ status: response.status, message: errorMessageOf(response.status, text) });
      }
      return yield* HttpIncomingMessage.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((error) => cliError(`Unexpected response from ${method} ${path}: ${messageOf(error)}`)),
      );
    });

    return { baseUrl, call };
  }),
);
