import * as Schema from 'effect/Schema';

export const OrgId = Schema.String.pipe(Schema.brand('OrgId'));
export const UserId = Schema.String.pipe(Schema.brand('UserId'));

export const INTERNAL_INTEGRATION_SLUG = 'agentdock_internal';
export const HOME_INTERNAL_AGENT_ID = 'agentdock-home';

export type OrgId = typeof OrgId.Type;
export type UserId = typeof UserId.Type;
