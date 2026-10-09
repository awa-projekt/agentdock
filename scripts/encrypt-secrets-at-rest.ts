import 'dotenv/config';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { ResultSet } from '@libsql/client';
import * as Console from 'effect/Console';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { client, SecretCipher, SecretCipherLive } from '../packages/db/src/index.ts';

class EncryptSecretsMigrationError extends Data.TaggedError('EncryptSecretsMigrationError')<{
  readonly cause: unknown;
}> {}

const tryMigration = <A>(try_: () => Promise<A>) =>
  Effect.tryPromise({ try: try_, catch: (cause) => new EncryptSecretsMigrationError({ cause }) });

const decodeRows = <A>(schema: Schema.Codec<A>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(schema));
  return (rows: ResultSet['rows']) =>
    decode(rows).pipe(Effect.mapError((cause) => new EncryptSecretsMigrationError({ cause })));
};

const decodeProviderKeyRows = decodeRows(Schema.Struct({ provider: Schema.String, api_key: Schema.String }));
const decodeCustomProviderRows = decodeRows(Schema.Struct({ id: Schema.String, api_key: Schema.String }));

const encryptExistingSecrets = Effect.gen(function* () {
  const cipher = yield* SecretCipher;
  let providerKeyCount = 0;
  let customProviderCount = 0;

  const providerKeys = yield* tryMigration(() => client.execute('select provider, api_key from provider_keys'));
  for (const { provider, api_key: apiKey } of yield* decodeProviderKeyRows(providerKeys.rows)) {
    const encrypted = yield* cipher.encrypt(apiKey);
    yield* tryMigration(() =>
      client.execute({ sql: 'update provider_keys set api_key = ? where provider = ?', args: [encrypted, provider] }),
    );
    providerKeyCount += 1;
  }

  const customProviders = yield* tryMigration(() => client.execute('select id, api_key from custom_providers'));
  for (const { id, api_key: apiKey } of yield* decodeCustomProviderRows(customProviders.rows)) {
    const encrypted = yield* cipher.encrypt(apiKey);
    yield* tryMigration(() =>
      client.execute({ sql: 'update custom_providers set api_key = ? where id = ?', args: [encrypted, id] }),
    );
    customProviderCount += 1;
  }

  return { providerKeyCount, customProviderCount };
}).pipe(Effect.provide(SecretCipherLive));

const main = Effect.gen(function* () {
  const result = yield* encryptExistingSecrets;
  yield* Console.log(
    [
      'Encrypted secrets at rest.',
      `provider_keys: ${result.providerKeyCount}`,
      `custom_providers: ${result.customProviderCount}`,
    ].join('\n'),
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
