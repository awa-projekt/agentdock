import * as Schema from 'effect/Schema';

export const ChannelAccountId = Schema.String.pipe(Schema.brand('ChannelAccountId'));
export const ChannelBindingId = Schema.String.pipe(Schema.brand('ChannelBindingId'));

export const ChannelPlatform = Schema.Literals(['discord', 'teams']);

/**
 * Credentials for a Discord application acting as a bot. The public key is
 * only needed for HTTP interactions; the gateway websocket works without it.
 */
export const DiscordCredentialsInput = Schema.Struct({
  botToken: Schema.String,
  applicationId: Schema.String,
  publicKey: Schema.optional(Schema.String),
});

export const TeamsCredentialsInput = Schema.Union([
  Schema.Struct({
    appId: Schema.String,
    appPassword: Schema.String,
    appType: Schema.Literal('MultiTenant'),
  }),
  Schema.Struct({
    appId: Schema.String,
    appPassword: Schema.String,
    appType: Schema.Literal('SingleTenant'),
    tenantId: Schema.String,
  }),
]);

const ChannelAccountInputFields = {
  name: Schema.String,
  enabled: Schema.Boolean,
};

export const CreateChannelAccountInput = Schema.Union([
  Schema.Struct({
    ...ChannelAccountInputFields,
    platform: Schema.Literal('discord'),
    credentials: DiscordCredentialsInput,
  }),
  Schema.Struct({
    ...ChannelAccountInputFields,
    platform: Schema.Literal('teams'),
    credentials: TeamsCredentialsInput,
  }),
]);

/** Credentials are optional on update: omit them to keep the stored token. */
export const UpdateChannelAccountInput = Schema.Union([
  Schema.Struct({
    ...ChannelAccountInputFields,
    platform: Schema.Literal('discord'),
    credentials: Schema.optional(DiscordCredentialsInput),
  }),
  Schema.Struct({
    ...ChannelAccountInputFields,
    platform: Schema.Literal('teams'),
    credentials: Schema.optional(TeamsCredentialsInput),
  }),
]);

const ChannelAccountFields = {
  id: ChannelAccountId,
  name: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};

export const DiscordChannelAccount = Schema.Struct({
  ...ChannelAccountFields,
  platform: Schema.Literal('discord'),
  applicationId: Schema.String,
  botTokenMask: Schema.String,
});

export const TeamsChannelAccount = Schema.Union([
  Schema.Struct({
    ...ChannelAccountFields,
    platform: Schema.Literal('teams'),
    appId: Schema.String,
    appPasswordMask: Schema.String,
    appType: Schema.Literal('MultiTenant'),
  }),
  Schema.Struct({
    ...ChannelAccountFields,
    platform: Schema.Literal('teams'),
    appId: Schema.String,
    appPasswordMask: Schema.String,
    appType: Schema.Literal('SingleTenant'),
    tenantId: Schema.String,
  }),
]);

export const ChannelAccount = Schema.Union([DiscordChannelAccount, TeamsChannelAccount]);

export const ChannelAccountList = Schema.Array(ChannelAccount);

export const ChannelTarget = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow']),
  id: Schema.String,
});

/**
 * Which conversations a binding applies to. All set fields must match. An
 * empty match is the account-wide fallback. `peerKind: 'direct'` matches DMs
 * (optionally from one user), `peerKind: 'channel'` matches one Discord
 * channel including its threads, `workspaceId` matches a Discord server or
 * Microsoft Team.
 */
export const ChannelBindingMatch = Schema.Struct({
  peerKind: Schema.optional(Schema.Literals(['direct', 'channel'])),
  peerId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
});

export const CreateChannelBindingInput = Schema.Struct({
  accountId: ChannelAccountId,
  name: Schema.String,
  enabled: Schema.Boolean,
  target: ChannelTarget,
  match: ChannelBindingMatch,
  /** In group channels, only react when the bot is mentioned. Ignored for DMs. */
  requireMention: Schema.Boolean,
  /** Platform user IDs allowed to talk to the target; empty allows everyone the match admits. */
  allowedUserIds: Schema.Array(Schema.String),
});

export const UpdateChannelBindingInput = CreateChannelBindingInput;

export const ChannelBinding = Schema.Struct({
  id: ChannelBindingId,
  accountId: ChannelAccountId,
  name: Schema.String,
  enabled: Schema.Boolean,
  target: ChannelTarget,
  match: ChannelBindingMatch,
  requireMention: Schema.Boolean,
  allowedUserIds: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const ChannelBindingList = Schema.Array(ChannelBinding);

export const ChannelAccountConnectionState = Schema.Literals(['connecting', 'connected', 'disconnected', 'error']);

/** Live gateway connection status for one account, reported by the running server. */
export const ChannelAccountStatus = Schema.Struct({
  accountId: ChannelAccountId,
  state: ChannelAccountConnectionState,
  botUserName: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  since: Schema.Number,
});

export const ChannelAccountStatusList = Schema.Array(ChannelAccountStatus);

export const RemoveChannelResponse = Schema.Struct({ removed: Schema.Boolean });

export type ChannelAccountId = typeof ChannelAccountId.Type;
export type ChannelBindingId = typeof ChannelBindingId.Type;
export type ChannelPlatform = typeof ChannelPlatform.Type;
export type DiscordCredentialsInput = typeof DiscordCredentialsInput.Type;
export type TeamsCredentialsInput = typeof TeamsCredentialsInput.Type;
export type CreateChannelAccountInput = typeof CreateChannelAccountInput.Type;
export type UpdateChannelAccountInput = typeof UpdateChannelAccountInput.Type;
export type ChannelAccount = typeof ChannelAccount.Type;
export type ChannelTarget = typeof ChannelTarget.Type;
export type ChannelBindingMatch = typeof ChannelBindingMatch.Type;
export type CreateChannelBindingInput = typeof CreateChannelBindingInput.Type;
export type UpdateChannelBindingInput = typeof UpdateChannelBindingInput.Type;
export type ChannelBinding = typeof ChannelBinding.Type;
export type ChannelAccountConnectionState = typeof ChannelAccountConnectionState.Type;
export type ChannelAccountStatus = typeof ChannelAccountStatus.Type;
