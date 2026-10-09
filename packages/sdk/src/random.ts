import * as Effect from 'effect/Effect';
import * as Random from 'effect/Random';

const BYTE_INDICES = Array.from({ length: 16 }, (_, index) => index);

const versionedByte = (index: number, byte: number): number => {
  if (index === 6) return (byte & 0x0f) | 0x40;
  if (index === 8) return (byte & 0x3f) | 0x80;
  return byte;
};

/** A version 4 UUID drawn from Effect's `Random`, so seeded runs stay reproducible. */
export const randomUUIDv4: Effect.Effect<string> = Effect.map(
  Effect.forEach(BYTE_INDICES, (index) =>
    Effect.map(Random.nextIntBetween(0, 255), (byte) => versionedByte(index, byte)),
  ),
  (bytes) => {
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
);
