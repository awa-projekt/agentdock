import { type AgentCard } from '@a2a-js/sdk';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Effect } from 'effect';
import { logOneLineError, toA2AError } from './shared';

type AgentCardProvider =
  | { getAgentCard(): Promise<AgentCard> }
  | (() => Promise<AgentCard>);

type AgentCardHandlerOptions = {
  agentCardProvider: AgentCardProvider;
};

export const agentCardHandler = (
  options: AgentCardHandlerOptions,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const provider =
      typeof options.agentCardProvider === 'function'
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
