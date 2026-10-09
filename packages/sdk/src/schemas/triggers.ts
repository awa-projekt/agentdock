import * as Schema from 'effect/Schema';

export const TriggerId = Schema.String.pipe(Schema.brand('TriggerId'));

/**
 * A trigger fires an a2a task at an agent or workflow. The target is addressed
 * the same way a2a tasks are stored (`agent:<id>` / `workflow:<id>`); here it is
 * modelled as a struct so dispatch can pick the right a2a URL builder.
 */
export const TriggerTarget = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow']),
  id: Schema.String,
});

/** A text part whose `text` may contain `{{path}}` / `{{payload}}` placeholders. */
export const TriggerTextPartTemplate = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
});

/**
 * A data part. `template` is a JSON document in which `{{path}}` / `{{payload}}`
 * placeholders expand to JSON literals before it is parsed, so
 * `{ "all": {{payload}} }` passes the whole payload through and
 * `{ "from": {{from}} }` injects one field. Use `{{payload}}` alone for a raw
 * passthrough of the event.
 */
export const TriggerDataPartTemplate = Schema.Struct({
  kind: Schema.Literal('data'),
  template: Schema.String,
});

export const TriggerPartTemplate = Schema.Union([TriggerTextPartTemplate, TriggerDataPartTemplate]);

/** The a2a message parts a trigger sends when it fires, before rendering. */
export const TriggerTaskTemplate = Schema.Struct({
  parts: Schema.Array(TriggerPartTemplate),
});

/** Run on a cron schedule (5-field, e.g. `*​/5 * * * *`). */
export const ScheduleTriggerSpec = Schema.Struct({
  type: Schema.Literal('schedule'),
  cron: Schema.String,
  timezone: Schema.optional(Schema.String),
});

/** Fire when an authenticated request hits `POST /triggers/:id/webhook`. */
export const WebhookTriggerSpec = Schema.Struct({
  type: Schema.Literal('webhook'),
  secret: Schema.String,
});

/** Optional content filter applied to incoming mail before firing. */
export const EmailMatch = Schema.Struct({
  from: Schema.optional(Schema.String),
  subjectContains: Schema.optional(Schema.String),
});

/**
 * Fire when mail arrives in a monitored Microsoft 365 mailbox. `mailbox` is the
 * primary SMTP address of a (usually shared) mailbox the Graph app is scoped to.
 */
export const EmailTriggerSpec = Schema.Struct({
  type: Schema.Literal('email'),
  mailbox: Schema.String,
  match: Schema.optional(EmailMatch),
});

export const TriggerSpec = Schema.Union([ScheduleTriggerSpec, WebhookTriggerSpec, EmailTriggerSpec]);

export const CreateTriggerInput = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  target: TriggerTarget,
  taskTemplate: TriggerTaskTemplate,
  spec: TriggerSpec,
});

export const UpdateTriggerInput = CreateTriggerInput;

export const Trigger = Schema.Struct({
  id: TriggerId,
  name: Schema.String,
  enabled: Schema.Boolean,
  target: TriggerTarget,
  taskTemplate: TriggerTaskTemplate,
  spec: TriggerSpec,
  /** ISO timestamp of the next scheduled fire; schedule triggers only. */
  nextRunAt: Schema.optional(Schema.String),
  /** ISO timestamp of the most recent fire attempt. */
  lastRunAt: Schema.optional(Schema.String),
  /** Message from the most recent failed fire, cleared on success. */
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const TriggerList = Schema.Array(Trigger);

export const RemoveTriggerResponse = Schema.Struct({
  removed: Schema.Boolean,
});

export type TriggerId = Schema.Schema.Type<typeof TriggerId>;
export type TriggerTarget = Schema.Schema.Type<typeof TriggerTarget>;
export type TriggerTextPartTemplate = Schema.Schema.Type<typeof TriggerTextPartTemplate>;
export type TriggerDataPartTemplate = Schema.Schema.Type<typeof TriggerDataPartTemplate>;
export type TriggerPartTemplate = Schema.Schema.Type<typeof TriggerPartTemplate>;
export type TriggerTaskTemplate = Schema.Schema.Type<typeof TriggerTaskTemplate>;
export type ScheduleTriggerSpec = Schema.Schema.Type<typeof ScheduleTriggerSpec>;
export type WebhookTriggerSpec = Schema.Schema.Type<typeof WebhookTriggerSpec>;
export type EmailMatch = Schema.Schema.Type<typeof EmailMatch>;
export type EmailTriggerSpec = Schema.Schema.Type<typeof EmailTriggerSpec>;
export type TriggerSpec = Schema.Schema.Type<typeof TriggerSpec>;
export type CreateTriggerInput = Schema.Schema.Type<typeof CreateTriggerInput>;
export type UpdateTriggerInput = Schema.Schema.Type<typeof UpdateTriggerInput>;
export type Trigger = Schema.Schema.Type<typeof Trigger>;
