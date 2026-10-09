import * as NodeHttpPlatform from '@effect/platform-node/NodeHttpPlatform';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { AgentdockApi } from 'agentdock-sdk/api';
import { ApiFailure } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Etag from 'effect/http/Etag';
import * as HttpApiTest from 'effect/http-api/HttpApiTest';
import * as Layer from 'effect/Layer';
import { ServerFailuresLive } from './server-failures';

const TestLayer = Layer.mergeAll(ServerFailuresLive, NodeServices.layer, NodeHttpPlatform.layer, Etag.layer);

describe('ServerFailures', () => {
  it.effect('answers a defect with the trace id of the failed request', () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(AgentdockApi, []);
      const span = yield* Effect.currentSpan;
      const failure = yield* Effect.flip(client.general.health());

      expect(failure).toBeInstanceOf(ApiFailure);
      expect(failure).toMatchObject({ traceId: span.traceId });
    }).pipe(Effect.withSpan('test'), Effect.scoped, Effect.provide(TestLayer)),
  );
});
