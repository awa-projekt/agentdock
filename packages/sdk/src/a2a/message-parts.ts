import type { Message } from '@a2a-js/sdk';
import type { RequestContext } from '@a2a-js/sdk/server';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { AgentRunPart } from '../schemas/agent-runs';
import { INTEGRATION_OVERRIDES_METADATA_KEY, IntegrationOverrides } from '../schemas/integrations';
import { coerceJson, jsonProperty, jsonString } from '../schemas/json';
import { decodeWorkflowA2AEnvelopeOption } from '../schemas/workflows';
import { toAgentRunPart } from './run-record';

const decodeIntegrationOverrides = Schema.decodeUnknownOption(IntegrationOverrides);

/** A data part that steers the run (an answer to an interrupt, a workflow envelope) rather than talks to the model. */
const isControlPart = (part: Message['parts'][number]): boolean => {
  if (part.kind !== 'data') return false;
  const data = coerceJson(part.data);
  return jsonString(data, 'type') === 'input-required-response' || Option.isSome(decodeWorkflowA2AEnvelopeOption(data));
};

/** What a message says to the agent: its text, files and data parts, without the control parts. */
export const agentInputParts = (message: Message): ReadonlyArray<AgentRunPart> =>
  message.parts.filter((part) => !isControlPart(part)).map(toAgentRunPart);

/**
 * The integration overrides a task runs with: those the message that started
 * it carried, so a resumed or recovered task keeps them and a later message
 * cannot change them. The host admits them only from callers allowed to set
 * them; see `INTEGRATION_OVERRIDES_METADATA_KEY`.
 */
export const integrationOverridesOf = (requestContext: RequestContext): IntegrationOverrides | undefined => {
  const first = requestContext.task?.history?.find((message) => message.role === 'user') ?? requestContext.userMessage;
  const raw = jsonProperty(coerceJson(first.metadata ?? {}), INTEGRATION_OVERRIDES_METADATA_KEY);
  return raw === undefined ? undefined : Option.getOrUndefined(decodeIntegrationOverrides(raw));
};

/**
 * The overrides a message asks for, for hosts that check who may set them:
 * `None` when it asks for none, `Some(None)` when the value does not read as
 * overrides, which a host should reject rather than run without them.
 */
export const requestedIntegrationOverrides = (
  metadata: Message['metadata'],
): Option.Option<Option.Option<IntegrationOverrides>> => {
  const raw = jsonProperty(coerceJson(metadata ?? {}), INTEGRATION_OVERRIDES_METADATA_KEY);
  return raw === undefined ? Option.none() : Option.some(decodeIntegrationOverrides(raw));
};
