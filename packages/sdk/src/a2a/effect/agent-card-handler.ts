import type { AgentCard } from '@a2a-js/sdk';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Predicate from 'effect/Predicate';
import { logOneLineError, toA2AError } from './shared';

type AgentCardProvider = { getAgentCard(): Promise<AgentCard> } | (() => Promise<AgentCard>);

type AgentCardHandlerOptions = {
  agentCardProvider: AgentCardProvider;
};

export const agentCardHandler = (
  options: AgentCardHandlerOptions,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const provider = Predicate.isFunction(options.agentCardProvider)
      ? options.agentCardProvider
      : options.agentCardProvider.getAgentCard.bind(options.agentCardProvider);

    const response = yield* Effect.tryPromise({
      try: provider,
      catch: (error) => toA2AError(error, 'Failed to retrieve agent card'),
    }).pipe(
      Effect.withSpan('agentdock.a2a.agent_card.fetch'),
      Effect.map((agentCard) => HttpServerResponse.jsonUnsafe(agentCard)),
      Effect.catch((error) => {
        logOneLineError(`A2A agent card error ${request.method} ${request.url}`, error);
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error: error.message,
            },
            { status: 500 },
          ),
        );
      }),
    );

    return response;
  });
