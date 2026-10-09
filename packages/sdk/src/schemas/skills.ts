import * as Schema from 'effect/Schema';

export const SkillId = Schema.String.pipe(Schema.brand('SkillId'));

export const Skill = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
  license: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  /** Shipped with the server; it cannot be replaced or removed. */
  builtin: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SkillList = Schema.Array(Skill);

export const CreateSkillInput = Schema.Struct({
  content: Schema.String,
  source: Schema.optional(Schema.String),
});

export const PullSkillsInput = Schema.Struct({
  source: Schema.String,
  skills: Schema.Array(Schema.String),
});

export const PullSkillsResponse = Schema.Struct({
  skills: SkillList,
});

export const RemoveSkillResponse = Schema.Struct({
  removed: Schema.Boolean,
});

export type SkillId = Schema.Schema.Type<typeof SkillId>;
export type Skill = Schema.Schema.Type<typeof Skill>;
export type CreateSkillInput = Schema.Schema.Type<typeof CreateSkillInput>;
export type PullSkillsInput = Schema.Schema.Type<typeof PullSkillsInput>;
export type PullSkillsResponse = Schema.Schema.Type<typeof PullSkillsResponse>;
export type RemoveSkillResponse = Schema.Schema.Type<typeof RemoveSkillResponse>;
