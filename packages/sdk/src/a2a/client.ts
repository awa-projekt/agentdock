import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';
import * as Effect from 'effect/Effect';
import type * as HttpClient from 'effect/http/HttpClient';
import { httpClientFetch } from '../tracing';

/** An A2A client factory whose requests are client spans under the current span and carry its trace headers. */
export const tracedA2aClientFactory: Effect.Effect<ClientFactory, never, HttpClient.HttpClient> = Effect.map(
  Effect.context<HttpClient.HttpClient>(),
  (context) => {
    const fetchImpl = httpClientFetch(context);
    return new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      }),
    );
  },
);
