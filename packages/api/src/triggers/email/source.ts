import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

/** A mailbox message normalised to the shape trigger payloads resolve against. */
export type NormalizedEmail = {
  readonly id: string;
  readonly mailbox: string;
  readonly subject: string;
  readonly from: string;
  readonly receivedDateTime: string;
  readonly bodyPreview: string;
  readonly body: string;
};

export class EmailSourceError extends Schema.TaggedError<EmailSourceError>()('EmailSourceError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * Port for reading inbound mail. The v1 layer polls Microsoft Graph; a Graph
 * change-notification (push) layer can be swapped in later without touching the
 * scheduler or trigger code. `enabled` is false when Graph credentials are
 * absent, so the scheduler can skip email work cheaply.
 */
export type EmailSourceService = {
  readonly enabled: boolean;
  /** Messages in `mailbox` with `receivedDateTime` strictly after `sinceIso`, oldest first. */
  readonly fetchSince: (
    mailbox: string,
    sinceIso: string,
  ) => Effect.Effect<ReadonlyArray<NormalizedEmail>, EmailSourceError>;
};

export const EmailSource = Context.Service<EmailSourceService>('@agentdock/api/EmailSource');
