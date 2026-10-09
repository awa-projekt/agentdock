import * as NodeCrypto from 'node:crypto';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';

const algorithm = 'aes-256-gcm';
const ivBytes = 12;
const minSecretKeyBytes = 32;
const localDevelopmentSecret = 'agentdock-local-development-secret-key-change-me';

export class SecretCipherConfigError extends Schema.TaggedError<SecretCipherConfigError>()('SecretCipherConfigError', {
  message: Schema.String,
}) {}

export class SecretCipherError extends Schema.TaggedError<SecretCipherError>()('SecretCipherError', {
  operation: Schema.Literals(['encrypt', 'decrypt']),
  cause: Schema.Defect(),
}) {}

export type SecretCipherKeyService = {
  readonly key: Buffer;
};

/** The 32-byte key every at-rest secret in the platform is sealed with. */
export const SecretCipherKey = Context.Service<SecretCipherKeyService>('@agentdock/db/SecretCipherKey');

const validateSecretKey = (value: string, nodeEnv: string) =>
  Effect.gen(function* () {
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength < minSecretKeyBytes) {
      return yield* new SecretCipherConfigError({
        message: `AGENTDOCK_SECRET_KEY must be at least ${minSecretKeyBytes} bytes for AES-256-GCM secret encryption.`,
      });
    }
    if (nodeEnv !== 'development' && value === localDevelopmentSecret) {
      return yield* new SecretCipherConfigError({
        message: 'AGENTDOCK_SECRET_KEY must be set outside development.',
      });
    }
    return NodeCrypto.createHash('sha256').update(value, 'utf8').digest();
  });

export const SecretCipherKeyLive = Layer.effect(
  SecretCipherKey,
  Effect.gen(function* () {
    const nodeEnv = yield* Config.String('NODE_ENV').pipe(Config.orElse(() => Config.succeed('development')));
    const configured = yield* Config.option(Config.Redacted('AGENTDOCK_SECRET_KEY'));
    const rawSecret = Option.match(configured, {
      onSome: (value) => Redacted.value(value),
      onNone: () => localDevelopmentSecret,
    });
    const secret = rawSecret.trim().length === 0 && nodeEnv === 'development' ? localDevelopmentSecret : rawSecret;
    const key = yield* validateSecretKey(secret, nodeEnv);
    if (secret === localDevelopmentSecret) {
      yield* Effect.logWarning(
        'AGENTDOCK_SECRET_KEY is not set: stored provider keys and integration credentials are encrypted with the publicly known development key. Set AGENTDOCK_SECRET_KEY for any data you keep.',
      );
    }
    return SecretCipherKey.of({ key });
  }),
);

export type SecretCipherService = {
  readonly encrypt: (plaintext: string) => Effect.Effect<string, SecretCipherError>;
  readonly decrypt: (ciphertext: string) => Effect.Effect<string, SecretCipherError>;
};

export const SecretCipher = Context.Service<SecretCipherService>('@agentdock/db/SecretCipher');

export const makeSecretCipherLayer = (secretKey: string) =>
  Layer.effect(
    SecretCipher,
    Effect.gen(function* () {
      const key = yield* validateSecretKey(secretKey, 'development');
      return SecretCipher.of(makeSecretCipher(key));
    }),
  );

const makeSecretCipher = (key: Buffer): SecretCipherService => ({
  encrypt: (plaintext) =>
    Effect.try({
      try: () => {
        const iv = NodeCrypto.randomBytes(ivBytes);
        const cipher = NodeCrypto.createCipheriv(algorithm, key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [iv, tag, encrypted].map((part) => part.toString('base64')).join(':');
      },
      catch: (cause) => new SecretCipherError({ operation: 'encrypt', cause }),
    }),
  decrypt: (ciphertext) =>
    Effect.try({
      try: () => {
        const parts = ciphertext.split(':');
        // ciphertextPart may be an empty string: AES-GCM encryption of an empty
        // secret yields a valid iv and auth tag with zero-length ciphertext
        // (serialized as `iv:tag:`). Reject only structurally broken envelopes.
        const [ivPart, tagPart, ciphertextPart] = parts;
        if (parts.length !== 3 || !ivPart || !tagPart || ciphertextPart === undefined) {
          throw new Error('Invalid encrypted secret envelope.');
        }
        const iv = Buffer.from(ivPart, 'base64');
        const tag = Buffer.from(tagPart, 'base64');
        const encrypted = Buffer.from(ciphertextPart, 'base64');
        const decipher = NodeCrypto.createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      },
      catch: (cause) => new SecretCipherError({ operation: 'decrypt', cause }),
    }),
});

export const SecretCipherLive = Layer.effect(
  SecretCipher,
  Effect.gen(function* () {
    const { key } = yield* SecretCipherKey;
    return SecretCipher.of(makeSecretCipher(key));
  }),
).pipe(Layer.provide(SecretCipherKeyLive));
