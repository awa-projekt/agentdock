import {
  IntegrationNotFoundError,
  IntegrationOperationError,
  IntegrationUnreachableError,
} from 'agentdock-sdk/schemas';
import { causeMessage } from 'db';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

export type IntegrationFailure = IntegrationOperationError | IntegrationNotFoundError;

const isIntegrationFailure = Schema.is(Schema.Union([IntegrationOperationError, IntegrationNotFoundError]));

/** Every gateway and host failure carries a message; the API contract knows two shapes. */
export const asIntegrationFailure = <A, E extends Error, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, IntegrationFailure, R> =>
  Effect.mapError(effect, (failure) =>
    isIntegrationFailure(failure) ? failure : new IntegrationOperationError({ message: failure.message }),
  );

export const operationError = (cause: unknown): IntegrationOperationError =>
  new IntegrationOperationError({ message: causeMessage(cause) });

export const notFound = (message: string): IntegrationNotFoundError => new IntegrationNotFoundError({ message });

/** What invoking a tool can fail with: the gateway's failures, or a server out of reach. */
export type InvocationFailure = IntegrationFailure | IntegrationUnreachableError;

const isInvocationFailure = Schema.is(
  Schema.Union([IntegrationOperationError, IntegrationNotFoundError, IntegrationUnreachableError]),
);

/** Like {@link asIntegrationFailure}, keeping an unreachable server apart: a run ends on it. */
export const asInvocationFailure = <A, E extends Error, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InvocationFailure, R> =>
  Effect.mapError(effect, (failure) =>
    isInvocationFailure(failure) ? failure : new IntegrationOperationError({ message: failure.message }),
  );
