import * as Schema from 'effect/Schema';

/** A slice of server state the dashboard caches. */
export const ChangedResource = Schema.Literals([
  'agents',
  'workflows',
  'workflowRuns',
  'skills',
  'triggers',
  'channels',
  'evals',
  'integrations',
  'approvals',
  'audit',
  'providerKeys',
  'sessions',
  'mcpAccess',
]);
export type ChangedResource = typeof ChangedResource.Type;

/**
 * What `GET /events` streams. `Subscribed` opens every connection once the
 * server listens for changes, so anything a client fetched before it may be
 * stale; `Changed` names the slices written since.
 */
export const ServerEvent = Schema.Union([
  Schema.TaggedStruct('Subscribed', {}),
  Schema.TaggedStruct('Changed', { resources: Schema.Array(ChangedResource) }),
]);
export type ServerEvent = typeof ServerEvent.Type;
