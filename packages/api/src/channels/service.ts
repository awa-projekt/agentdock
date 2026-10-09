import { randomUUIDv4 } from 'agentdock-sdk';
import type {
  ChannelAccount,
  ChannelBinding,
  ChannelTarget,
  CreateChannelAccountInput,
  CreateChannelBindingInput,
  DiscordCredentialsInput,
  TeamsCredentialsInput,
  UpdateChannelAccountInput,
  UpdateChannelBindingInput,
} from 'agentdock-sdk/schemas';
import {
  ChannelAccount as ChannelAccountSchema,
  ChannelBinding as ChannelBindingSchema,
  CreateChannelAccountInput as CreateChannelAccountInputSchema,
  CreateChannelBindingInput as CreateChannelBindingInputSchema,
  UpdateChannelAccountInput as UpdateChannelAccountInputSchema,
  workflowInputContract,
} from 'agentdock-sdk/schemas';
import { workflowInputMode } from 'agentdock-sdk/workflows';
import {
  channelAccountsTable,
  channelBindingsTable,
  channelStateEntriesTable,
  channelStateListItemsTable,
  channelStateLocksTable,
  channelStateQueueItemsTable,
  channelStateSubscriptionsTable,
  channelThreadsTable,
  Database,
  SecretCipher,
} from 'db';
import { and, asc, eq } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { AgentRegistry } from '../agents/service';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { WorkflowRegistry } from '../workflows/service';

export class ChannelRegistryError extends Schema.TaggedError<ChannelRegistryError>()('ChannelRegistryError', {
  cause: Schema.Defect(),
}) {}

export class ChannelValidationError extends Schema.TaggedError<ChannelValidationError>()('ChannelValidationError', {
  message: Schema.String,
}) {}

/** Decrypted credentials; never leaves the server process. */
export type ChannelAccountCredentials =
  | { readonly platform: 'discord'; readonly credentials: DiscordCredentialsInput }
  | { readonly platform: 'teams'; readonly credentials: TeamsCredentialsInput };

type ChannelAccountCredentialInput =
  | { readonly platform: 'discord'; readonly credentials: DiscordCredentialsInput }
  | { readonly platform: 'teams'; readonly credentials: TeamsCredentialsInput };

export type ChannelThread = {
  readonly accountId: string;
  readonly threadId: string;
  readonly contextId: string;
  readonly target: ChannelTarget;
  readonly pendingTaskId: string | null;
};

type ChannelRegistryService = {
  readonly listAccounts: () => Effect.Effect<ReadonlyArray<ChannelAccount>, ChannelRegistryError>;
  readonly getAccount: (accountId: string) => Effect.Effect<ChannelAccount | null, ChannelRegistryError>;
  readonly addAccount: (
    input: CreateChannelAccountInput,
  ) => Effect.Effect<ChannelAccount, ChannelRegistryError | ChannelValidationError>;
  readonly updateAccount: (
    accountId: string,
    input: UpdateChannelAccountInput,
  ) => Effect.Effect<ChannelAccount | null, ChannelRegistryError | ChannelValidationError>;
  readonly removeAccount: (accountId: string) => Effect.Effect<boolean, ChannelRegistryError>;
  readonly getAccountCredentials: (
    accountId: string,
  ) => Effect.Effect<ChannelAccountCredentials | null, ChannelRegistryError>;
  readonly listBindings: () => Effect.Effect<ReadonlyArray<ChannelBinding>, ChannelRegistryError>;
  readonly listBindingsForAccount: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<ChannelBinding>, ChannelRegistryError>;
  readonly addBinding: (
    input: CreateChannelBindingInput,
  ) => Effect.Effect<ChannelBinding, ChannelRegistryError | ChannelValidationError>;
  readonly updateBinding: (
    bindingId: string,
    input: UpdateChannelBindingInput,
  ) => Effect.Effect<ChannelBinding | null, ChannelRegistryError | ChannelValidationError>;
  readonly removeBinding: (bindingId: string) => Effect.Effect<boolean, ChannelRegistryError>;
  readonly getThread: (
    accountId: string,
    threadId: string,
  ) => Effect.Effect<ChannelThread | null, ChannelRegistryError>;
  readonly saveThread: (thread: ChannelThread) => Effect.Effect<void, ChannelRegistryError>;
};

export const ChannelRegistry = Context.Service<ChannelRegistryService>('@agentdock/api/ChannelRegistry');

const decodeCreateAccountInput = Schema.decodeUnknownSync(CreateChannelAccountInputSchema);
const decodeUpdateAccountInput = Schema.decodeUnknownSync(UpdateChannelAccountInputSchema);
const decodeAccount = Schema.decodeUnknownSync(ChannelAccountSchema);
const decodeCreateBindingInput = Schema.decodeUnknownSync(CreateChannelBindingInputSchema);
const decodeBinding = Schema.decodeUnknownSync(ChannelBindingSchema);

const accountId = Effect.map(randomUUIDv4, (id) => `cha_${id.replaceAll('-', '').slice(0, 12)}`);
const bindingId = Effect.map(randomUUIDv4, (id) => `chb_${id.replaceAll('-', '').slice(0, 12)}`);

const toRegistryError = (cause: unknown): ChannelRegistryError => new ChannelRegistryError({ cause });
const tryDb = <A>(run: () => Promise<A>): Effect.Effect<A, ChannelRegistryError> =>
  Effect.tryPromise({ try: run, catch: toRegistryError });

const maskSecret = (secret: string): string => (secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`);

const StoredAccountCredentials = Schema.Union([
  Schema.Struct({
    platform: Schema.Literal('discord'),
    applicationId: Schema.String,
    botToken: Schema.String,
    publicKey: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    platform: Schema.Literal('teams'),
    appId: Schema.String,
    appPassword: Schema.String,
    appType: Schema.Literal('MultiTenant'),
  }),
  Schema.Struct({
    platform: Schema.Literal('teams'),
    appId: Schema.String,
    appPassword: Schema.String,
    appType: Schema.Literal('SingleTenant'),
    tenantId: Schema.String,
  }),
]);

type StoredAccountCredentials = typeof StoredAccountCredentials.Type;
const decodeStoredAccountCredentials = Schema.decodeUnknownSync(StoredAccountCredentials);

type AccountRow = typeof channelAccountsTable.$inferSelect;
type BindingRow = typeof channelBindingsTable.$inferSelect;
type ThreadRow = typeof channelThreadsTable.$inferSelect;

const rowToBinding = (row: BindingRow): ChannelBinding =>
  decodeBinding({
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    enabled: row.enabled,
    target: { kind: row.targetKind, id: row.targetId },
    match: row.match,
    requireMention: row.requireMention,
    allowedUserIds: row.allowedUserIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const rowToThread = (row: ThreadRow): ChannelThread => ({
  accountId: row.accountId,
  threadId: row.threadId,
  contextId: row.contextId,
  target: { kind: row.targetKind, id: row.targetId },
  pendingTaskId: row.pendingTaskId,
});

const validateMatch = (input: CreateChannelBindingInput): Effect.Effect<void, ChannelValidationError> =>
  input.match.peerId !== undefined && input.match.peerKind === undefined
    ? Effect.fail(new ChannelValidationError({ message: 'match.peerId requires match.peerKind' }))
    : Effect.void;

export const ChannelRegistryLive = Layer.effect(
  ChannelRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const cipher = yield* SecretCipher;
    const agents = yield* AgentRegistry;
    const workflows = yield* WorkflowRegistry;
    const changes = yield* ChangeFeed;
    const touchesChannels = changes.touches('channels');
    const clock = yield* Effect.clockWith(Effect.succeed);
    const nowMs = (): number => clock.currentTimeMillisUnsafe();

    const rowToAccount = (row: AccountRow): Effect.Effect<ChannelAccount, ChannelRegistryError> => {
      const credentials = decodeStoredAccountCredentials(row.credentials);
      const common = {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      if (credentials.platform === 'discord') {
        return cipher.decrypt(credentials.botToken).pipe(
          Effect.mapError(toRegistryError),
          Effect.map((botToken) =>
            decodeAccount({
              ...common,
              platform: 'discord',
              applicationId: credentials.applicationId,
              botTokenMask: maskSecret(botToken),
            }),
          ),
        );
      }
      return cipher.decrypt(credentials.appPassword).pipe(
        Effect.mapError(toRegistryError),
        Effect.map((appPassword) =>
          credentials.appType === 'SingleTenant'
            ? decodeAccount({
                ...common,
                platform: 'teams',
                appId: credentials.appId,
                appPasswordMask: maskSecret(appPassword),
                appType: 'SingleTenant',
                tenantId: credentials.tenantId,
              })
            : decodeAccount({
                ...common,
                platform: 'teams',
                appId: credentials.appId,
                appPasswordMask: maskSecret(appPassword),
                appType: 'MultiTenant',
              }),
        ),
      );
    };

    const encryptCredentials = (
      input: ChannelAccountCredentialInput,
    ): Effect.Effect<StoredAccountCredentials, ChannelRegistryError> => {
      if (input.platform === 'discord') {
        const credentials = input.credentials;
        return cipher.encrypt(credentials.botToken).pipe(
          Effect.mapError(toRegistryError),
          Effect.map((botToken) =>
            credentials.publicKey
              ? {
                  platform: 'discord' as const,
                  applicationId: credentials.applicationId,
                  botToken,
                  publicKey: credentials.publicKey,
                }
              : {
                  platform: 'discord' as const,
                  applicationId: credentials.applicationId,
                  botToken,
                },
          ),
        );
      }
      if (input.credentials.appType === 'SingleTenant') {
        const credentials = input.credentials;
        return cipher.encrypt(credentials.appPassword).pipe(
          Effect.mapError(toRegistryError),
          Effect.map((appPassword) => ({
            platform: 'teams' as const,
            appId: credentials.appId,
            appPassword,
            appType: 'SingleTenant' as const,
            tenantId: credentials.tenantId,
          })),
        );
      }
      const credentials = input.credentials;
      return cipher.encrypt(credentials.appPassword).pipe(
        Effect.mapError(toRegistryError),
        Effect.map((appPassword) => ({
          platform: 'teams' as const,
          appId: credentials.appId,
          appPassword,
          appType: 'MultiTenant' as const,
        })),
      );
    };

    const accountRow = (id: string): Effect.Effect<AccountRow | null, ChannelRegistryError> =>
      tryDb(() => db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id)).limit(1).all()).pipe(
        Effect.map((rows) => rows[0] ?? null),
      );

    const validateTarget = (
      input: CreateChannelBindingInput,
    ): Effect.Effect<void, ChannelRegistryError | ChannelValidationError> =>
      Effect.gen(function* () {
        yield* validateMatch(input);
        const account = yield* accountRow(input.accountId);
        if (!account) {
          return yield* new ChannelValidationError({ message: `channel account '${input.accountId}' does not exist` });
        }
        if (input.target.kind === 'agent') {
          const agent = yield* agents.getById(input.target.id).pipe(Effect.mapError(toRegistryError));
          if (!agent) {
            return yield* new ChannelValidationError({ message: `target agent '${input.target.id}' does not exist` });
          }
          return;
        }
        const workflow = yield* workflows.getById(input.target.id).pipe(Effect.mapError(toRegistryError));
        if (!workflow) {
          return yield* new ChannelValidationError({ message: `target workflow '${input.target.id}' does not exist` });
        }
        const mode = workflowInputMode(workflowInputContract(workflow));
        if (mode !== 'none' && mode !== 'text') {
          return yield* new ChannelValidationError({
            message: `target workflow '${input.target.id}' expects ${mode} input; channels deliver text`,
          });
        }
      });

    return ChannelRegistry.of({
      listAccounts: Effect.fn('ChannelRegistry.listAccounts')(function* () {
        const rows = yield* tryDb(() =>
          db.select().from(channelAccountsTable).orderBy(asc(channelAccountsTable.createdAt)).all(),
        );
        return yield* Effect.forEach(rows, rowToAccount);
      }),
      getAccount: Effect.fn('ChannelRegistry.getAccount')(function* (id) {
        const row = yield* accountRow(id);
        return row ? yield* rowToAccount(row) : null;
      }),
      addAccount: Effect.fn('ChannelRegistry.addAccount')(function* (input) {
        const validated = decodeCreateAccountInput(input);
        const credentials = yield* encryptCredentials(validated);
        const timestamp = nowMs();
        const row: AccountRow = {
          id: yield* accountId,
          name: validated.name,
          platform: validated.platform,
          enabled: validated.enabled,
          credentials,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        yield* tryDb(() => db.insert(channelAccountsTable).values(row).run());
        return yield* rowToAccount(row);
      }, touchesChannels),
      updateAccount: Effect.fn('ChannelRegistry.updateAccount')(function* (id, input) {
        const validated = decodeUpdateAccountInput(input);
        const existing = yield* accountRow(id);
        if (!existing) return null;
        const existingCredentials = decodeStoredAccountCredentials(existing.credentials);
        if (validated.platform !== existingCredentials.platform) {
          return yield* new ChannelValidationError({ message: 'A channel account platform cannot be changed.' });
        }
        let credentials = existingCredentials;
        if (validated.credentials) {
          credentials = yield* encryptCredentials(
            validated.platform === 'discord'
              ? { platform: 'discord', credentials: validated.credentials }
              : { platform: 'teams', credentials: validated.credentials },
          );
        }
        const row: AccountRow = {
          ...existing,
          name: validated.name,
          enabled: validated.enabled,
          platform: validated.platform,
          credentials,
          updatedAt: nowMs(),
        };
        yield* tryDb(() => db.update(channelAccountsTable).set(row).where(eq(channelAccountsTable.id, id)).run());
        return yield* rowToAccount(row);
      }, touchesChannels),
      removeAccount: Effect.fn('ChannelRegistry.removeAccount')(function* (id) {
        yield* tryDb(() => db.delete(channelBindingsTable).where(eq(channelBindingsTable.accountId, id)).run());
        yield* tryDb(() => db.delete(channelThreadsTable).where(eq(channelThreadsTable.accountId, id)).run());
        yield* tryDb(() =>
          db.delete(channelStateSubscriptionsTable).where(eq(channelStateSubscriptionsTable.scope, id)).run(),
        );
        yield* tryDb(() => db.delete(channelStateLocksTable).where(eq(channelStateLocksTable.scope, id)).run());
        yield* tryDb(() => db.delete(channelStateEntriesTable).where(eq(channelStateEntriesTable.scope, id)).run());
        yield* tryDb(() => db.delete(channelStateListItemsTable).where(eq(channelStateListItemsTable.scope, id)).run());
        yield* tryDb(() =>
          db.delete(channelStateQueueItemsTable).where(eq(channelStateQueueItemsTable.scope, id)).run(),
        );
        const result = yield* tryDb(() => db.delete(channelAccountsTable).where(eq(channelAccountsTable.id, id)).run());
        return result.rowsAffected > 0;
      }, touchesChannels),
      getAccountCredentials: Effect.fn('ChannelRegistry.getAccountCredentials')(function* (id) {
        const row = yield* accountRow(id);
        if (!row) return null;
        const credentials = decodeStoredAccountCredentials(row.credentials);
        if (credentials.platform === 'discord') {
          const botToken = yield* cipher.decrypt(credentials.botToken).pipe(Effect.mapError(toRegistryError));
          return {
            platform: 'discord',
            credentials: credentials.publicKey
              ? { botToken, applicationId: credentials.applicationId, publicKey: credentials.publicKey }
              : { botToken, applicationId: credentials.applicationId },
          };
        }
        const appPassword = yield* cipher.decrypt(credentials.appPassword).pipe(Effect.mapError(toRegistryError));
        return {
          platform: 'teams',
          credentials:
            credentials.appType === 'SingleTenant'
              ? {
                  appId: credentials.appId,
                  appPassword,
                  appType: 'SingleTenant',
                  tenantId: credentials.tenantId,
                }
              : { appId: credentials.appId, appPassword, appType: 'MultiTenant' },
        };
      }),
      listBindings: Effect.fn('ChannelRegistry.listBindings')(function* () {
        const rows = yield* tryDb(() =>
          db.select().from(channelBindingsTable).orderBy(asc(channelBindingsTable.createdAt)).all(),
        );
        return rows.map(rowToBinding);
      }),
      listBindingsForAccount: Effect.fn('ChannelRegistry.listBindingsForAccount')(function* (id) {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(channelBindingsTable)
            .where(eq(channelBindingsTable.accountId, id))
            .orderBy(asc(channelBindingsTable.createdAt))
            .all(),
        );
        return rows.map(rowToBinding);
      }),
      addBinding: Effect.fn('ChannelRegistry.addBinding')(function* (input) {
        const validated = decodeCreateBindingInput(input);
        yield* validateTarget(validated);
        const timestamp = nowMs();
        const binding = decodeBinding({
          ...validated,
          id: yield* bindingId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* tryDb(() =>
          db
            .insert(channelBindingsTable)
            .values({
              id: binding.id,
              accountId: binding.accountId,
              name: binding.name,
              enabled: binding.enabled,
              targetKind: binding.target.kind,
              targetId: binding.target.id,
              match: binding.match,
              requireMention: binding.requireMention,
              allowedUserIds: binding.allowedUserIds,
              createdAt: binding.createdAt,
              updatedAt: binding.updatedAt,
            })
            .run(),
        );
        return binding;
      }, touchesChannels),
      updateBinding: Effect.fn('ChannelRegistry.updateBinding')(function* (id, input) {
        const validated = decodeCreateBindingInput(input);
        yield* validateTarget(validated);
        const rows = yield* tryDb(() =>
          db.select().from(channelBindingsTable).where(eq(channelBindingsTable.id, id)).limit(1).all(),
        );
        const existing = rows[0];
        if (!existing) return null;
        const binding = decodeBinding({ ...validated, id, createdAt: existing.createdAt, updatedAt: nowMs() });
        yield* tryDb(() =>
          db
            .update(channelBindingsTable)
            .set({
              accountId: binding.accountId,
              name: binding.name,
              enabled: binding.enabled,
              targetKind: binding.target.kind,
              targetId: binding.target.id,
              match: binding.match,
              requireMention: binding.requireMention,
              allowedUserIds: binding.allowedUserIds,
              updatedAt: binding.updatedAt,
            })
            .where(eq(channelBindingsTable.id, id))
            .run(),
        );
        return binding;
      }, touchesChannels),
      removeBinding: Effect.fn('ChannelRegistry.removeBinding')(function* (id) {
        const result = yield* tryDb(() => db.delete(channelBindingsTable).where(eq(channelBindingsTable.id, id)).run());
        return result.rowsAffected > 0;
      }, touchesChannels),
      getThread: Effect.fn('ChannelRegistry.getThread')(function* (account, threadId) {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(channelThreadsTable)
            .where(and(eq(channelThreadsTable.accountId, account), eq(channelThreadsTable.threadId, threadId)))
            .limit(1)
            .all(),
        );
        return rows[0] ? rowToThread(rows[0]) : null;
      }),
      saveThread: Effect.fn('ChannelRegistry.saveThread')(function* (thread) {
        const timestamp = nowMs();
        yield* tryDb(() =>
          db
            .insert(channelThreadsTable)
            .values({
              accountId: thread.accountId,
              threadId: thread.threadId,
              contextId: thread.contextId,
              targetKind: thread.target.kind,
              targetId: thread.target.id,
              pendingTaskId: thread.pendingTaskId,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: [channelThreadsTable.accountId, channelThreadsTable.threadId],
              set: {
                contextId: thread.contextId,
                targetKind: thread.target.kind,
                targetId: thread.target.id,
                pendingTaskId: thread.pendingTaskId,
                updatedAt: timestamp,
              },
            })
            .run(),
        );
      }),
    });
  }),
).pipe(Layer.provide(ChangeFeedLive));
