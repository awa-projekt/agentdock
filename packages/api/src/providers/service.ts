import { type CustomProviderKind, type ModelRuntimeConfig, SUPPORTED_LLM_PROVIDERS } from 'agentdock-sdk';
import { CustomProviderKindSchema, type ProviderKey } from 'agentdock-sdk/schemas';
import {
  customProvidersTable,
  Database,
  type DatabaseClient,
  providerKeysTable,
  SecretCipher,
  type SecretCipherService,
  tryDbWith,
} from 'db';
import { eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { ProviderEnvConfig, type ProviderEnvConfigService } from '../config';
import { ChangeFeed, ChangeFeedLive } from '../events/service';

type CustomProvider = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly queryParams?: Record<string, string> | undefined;
  readonly kind: CustomProviderKind;
};

export type SetProviderKeyInput = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly name?: string;
  readonly queryParams?: Record<string, string>;
  readonly kind?: CustomProviderKind;
};

type ProviderKeyRegistryService = {
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderKey>, ProviderKeyError>;
  readonly set: (provider: string, input: SetProviderKeyInput) => Effect.Effect<ProviderKey, ProviderKeyError>;
  readonly remove: (provider: string) => Effect.Effect<boolean, ProviderKeyError>;
  readonly getRuntimeConfig: (provider: string) => Effect.Effect<ModelRuntimeConfig | undefined, ProviderKeyError>;
  readonly listCustom: () => Effect.Effect<ReadonlyArray<CustomProvider>, ProviderKeyError>;
};

export class ProviderKeyError extends Schema.TaggedError<ProviderKeyError>()('ProviderKeyError', {
  cause: Schema.Defect(),
}) {}

const tryDb = tryDbWith((cause) => new ProviderKeyError({ cause }));

const decodeCustomProviderKind = Schema.decodeUnknownOption(CustomProviderKindSchema);

/** The `kind` column is plain text, so a row written before a kind was added falls back to the column default. */
const customProviderKind = (kind: string): CustomProviderKind =>
  Option.getOrElse(decodeCustomProviderKind(kind), (): CustomProviderKind => 'openai-compatible');

const builtinDescriptor = (provider: string) => SUPPORTED_LLM_PROVIDERS.find((entry) => entry.id === provider);

const maskKey = (key: string): string => (key.length <= 4 ? '••••' : `••••${key.slice(-4)}`);

type ProviderDeps = {
  readonly db: DatabaseClient;
  readonly providerEnv: ProviderEnvConfigService;
  readonly cipher: SecretCipherService;
};

const toProviderKeyError = (cause: unknown) => new ProviderKeyError({ cause });

const readProviderKey = (
  db: DatabaseClient,
  cipher: SecretCipherService,
  provider: string,
): Effect.Effect<string | undefined, ProviderKeyError> =>
  Effect.gen(function* () {
    const rows = yield* tryDb(() =>
      db
        .select({ apiKey: providerKeysTable.apiKey })
        .from(providerKeysTable)
        .where(eq(providerKeysTable.provider, provider))
        .limit(1)
        .all(),
    );
    const apiKey = rows[0]?.apiKey;
    if (apiKey === undefined) return undefined;
    return yield* cipher.decrypt(apiKey).pipe(Effect.mapError(toProviderKeyError));
  });

const writeProviderKey = (
  db: DatabaseClient,
  cipher: SecretCipherService,
  provider: string,
  apiKey: string,
): Effect.Effect<void, ProviderKeyError> =>
  Effect.gen(function* () {
    const encryptedApiKey = yield* cipher.encrypt(apiKey).pipe(Effect.mapError(toProviderKeyError));
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* tryDb(() =>
      db
        .insert(providerKeysTable)
        .values({ provider, apiKey: encryptedApiKey, updatedAt })
        .onConflictDoUpdate({
          target: providerKeysTable.provider,
          set: { apiKey: encryptedApiKey, updatedAt },
        })
        .run(),
    ).pipe(Effect.asVoid);
  });

const deleteProviderKey = (db: DatabaseClient, provider: string): Effect.Effect<boolean, ProviderKeyError> =>
  tryDb(() => db.delete(providerKeysTable).where(eq(providerKeysTable.provider, provider)).run()).pipe(
    Effect.map((result) => result.rowsAffected > 0),
  );

type CustomProviderRow = typeof customProvidersTable.$inferSelect;

const decryptCustomProvider = (cipher: SecretCipherService, row: CustomProviderRow) =>
  cipher.decrypt(row.apiKey).pipe(
    Effect.map(
      (apiKey): CustomProvider => ({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey,
        kind: customProviderKind(row.kind),
        queryParams: row.queryParams ?? undefined,
      }),
    ),
    Effect.mapError(toProviderKeyError),
  );

const readCustomProviders = (db: DatabaseClient, cipher: SecretCipherService) =>
  Effect.fn('ProviderKeyRegistry.readCustom')(function* () {
    const rows = yield* tryDb(() => db.select().from(customProvidersTable).all());
    return yield* Effect.all(rows.map((row) => decryptCustomProvider(cipher, row)));
  });

const listProviderKeys = ({ db, providerEnv, cipher }: ProviderDeps) =>
  Effect.fn('ProviderKeyRegistry.list')(function* () {
    const result: Array<ProviderKey> = [];
    // Built-in providers (stored key, env fallback, or none).
    for (const descriptor of SUPPORTED_LLM_PROVIDERS) {
      const stored = yield* readProviderKey(db, cipher, descriptor.id);
      const envKey = yield* providerEnv.get(descriptor.envVar);
      const base = { provider: descriptor.id, name: descriptor.name };
      if (stored) {
        result.push({ ...base, source: 'stored', maskedKey: maskKey(stored) });
      } else if (Option.isSome(envKey)) {
        result.push({ ...base, source: 'env', maskedKey: maskKey(Redacted.value(envKey.value)) });
      } else {
        result.push({ ...base, source: 'none' });
      }
    }
    // Custom OpenAI-compatible providers.
    const custom = yield* readCustomProviders(db, cipher)();
    for (const entry of custom) {
      result.push({
        provider: entry.id,
        name: entry.name,
        source: 'stored',
        maskedKey: maskKey(entry.apiKey),
        custom: true,
        baseUrl: entry.baseUrl,
        kind: entry.kind,
        queryParams: entry.queryParams,
      });
    }
    return result;
  });

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const setProviderKey = (db: DatabaseClient, cipher: SecretCipherService) =>
  Effect.fn('ProviderKeyRegistry.set')(function* (provider: string, input: SetProviderKeyInput) {
    if (input.baseUrl) {
      const id = slugify(provider);
      if (id.length === 0) {
        return yield* new ProviderKeyError({ cause: 'Custom provider id must not be empty.' });
      }
      if (builtinDescriptor(id)) {
        return yield* new ProviderKeyError({ cause: `'${id}' is a built-in provider id.` });
      }
      const name = input.name?.trim() || id;
      const kind: CustomProviderKind = input.kind ?? 'openai-compatible';
      const queryParams = input.queryParams && Object.keys(input.queryParams).length > 0 ? input.queryParams : null;

      const existing = yield* tryDb(() =>
        db.select().from(customProvidersTable).where(eq(customProvidersTable.id, id)).limit(1).all(),
      );
      const existingProvider = existing[0] ? yield* decryptCustomProvider(cipher, existing[0]) : undefined;
      const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : existingProvider?.apiKey;
      if (!apiKey) {
        return yield* new ProviderKeyError({ cause: 'API key is required for a new provider.' });
      }
      const encryptedApiKey = yield* cipher.encrypt(apiKey).pipe(Effect.mapError(toProviderKeyError));
      const now = yield* Clock.currentTimeMillis;
      yield* tryDb(() =>
        db
          .insert(customProvidersTable)
          .values({
            id,
            name,
            baseUrl: input.baseUrl!,
            apiKey: encryptedApiKey,
            queryParams,
            kind,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: customProvidersTable.id,
            set: { name, baseUrl: input.baseUrl!, apiKey: encryptedApiKey, queryParams, kind, updatedAt: now },
          })
          .run(),
      );
      return {
        provider: id,
        name,
        source: 'stored' as const,
        maskedKey: maskKey(apiKey),
        custom: true,
        baseUrl: input.baseUrl,
        kind,
        queryParams: queryParams ?? undefined,
      };
    }

    const descriptor = builtinDescriptor(provider);
    if (!descriptor) {
      return yield* new ProviderKeyError({ cause: `Unknown provider '${provider}'.` });
    }
    yield* writeProviderKey(db, cipher, provider, input.apiKey);
    return {
      provider: descriptor.id,
      name: descriptor.name,
      source: 'stored' as const,
      maskedKey: maskKey(input.apiKey),
    };
  });

const removeProviderKey = (db: DatabaseClient) =>
  Effect.fn('ProviderKeyRegistry.remove')(function* (provider: string) {
    if (builtinDescriptor(provider)) return yield* deleteProviderKey(db, provider);
    return yield* tryDb(() => db.delete(customProvidersTable).where(eq(customProvidersTable.id, provider)).run()).pipe(
      Effect.map((result) => result.rowsAffected > 0),
    );
  });

/** `ModelRuntimeConfig` declares its options as exactly-optional, so an absent one is built by omission. */
type MutableModelRuntimeConfig = { -readonly [K in keyof ModelRuntimeConfig]: ModelRuntimeConfig[K] };

const getRuntimeConfig = ({ db, providerEnv, cipher }: ProviderDeps) =>
  Effect.fn('ProviderKeyRegistry.getRuntimeConfig')(function* (provider: string) {
    const descriptor = builtinDescriptor(provider);
    if (descriptor) {
      const stored = yield* readProviderKey(db, cipher, provider);
      const envKey = yield* providerEnv.get(descriptor.envVar);
      const apiKey = stored ?? (Option.isSome(envKey) ? Redacted.value(envKey.value) : undefined);
      return apiKey ? { apiKey } : {};
    }
    const rows = yield* tryDb(() =>
      db.select().from(customProvidersTable).where(eq(customProvidersTable.id, provider)).limit(1).all(),
    );
    const custom = rows[0];
    if (!custom) return undefined;
    const decrypted = yield* decryptCustomProvider(cipher, custom);
    const runtimeConfig: MutableModelRuntimeConfig = {
      apiKey: decrypted.apiKey,
      baseUrl: decrypted.baseUrl,
      kind: decrypted.kind,
    };
    if (decrypted.queryParams) runtimeConfig.queryParams = decrypted.queryParams;
    return runtimeConfig;
  });

export const ProviderKeyRegistry = Context.Service<ProviderKeyRegistryService>('@agentdock/api/ProviderKeyRegistry');

export const ProviderKeyRegistryLive = Layer.effect(
  ProviderKeyRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const providerEnv = yield* ProviderEnvConfig;
    const cipher = yield* SecretCipher;
    const changes = yield* ChangeFeed;
    const deps = { db, providerEnv, cipher };
    const list = listProviderKeys(deps);
    const set = setProviderKey(db, cipher);
    const remove = removeProviderKey(db);
    const runtimeConfig = getRuntimeConfig(deps);
    const listCustom = readCustomProviders(db, cipher);
    return ProviderKeyRegistry.of({
      list: () => list(),
      set: (provider, input) => set(provider, input).pipe(changes.touches('providerKeys')),
      remove: (provider) => remove(provider).pipe(changes.touches('providerKeys')),
      getRuntimeConfig: (provider) => runtimeConfig(provider),
      listCustom: () => listCustom(),
    });
  }),
).pipe(Layer.provide(ChangeFeedLive));
