import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { makeSecretCipherLayer, SecretCipher } from './secret-cipher';

const testLayer = makeSecretCipherLayer('agentdock-test-secret-key-with-at-least-32-bytes');

describe('SecretCipher', () => {
  it.effect('round-trips plaintext through AES-GCM envelope encryption', () =>
    Effect.gen(function* () {
      const cipher = yield* SecretCipher;
      const plaintext = 'sk-test-secret-value';
      const ciphertext = yield* cipher.encrypt(plaintext);
      const decrypted = yield* cipher.decrypt(ciphertext);

      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.split(':')).toHaveLength(3);
      expect(decrypted).toBe(plaintext);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('fails when ciphertext is tampered with', () =>
    Effect.gen(function* () {
      const cipher = yield* SecretCipher;
      const ciphertext = yield* cipher.encrypt('sk-test-secret-value');
      const tampered = `${ciphertext.slice(0, -1)}${ciphertext.endsWith('A') ? 'B' : 'A'}`;

      const failure = yield* Effect.flip(cipher.decrypt(tampered));
      expect(failure).toBeDefined();
    }).pipe(Effect.provide(testLayer)),
  );
});
