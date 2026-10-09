import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

/**
 * The JSON domain used wherever a payload is genuinely open-ended: workflow
 * runtime state, a2a data parts, tool arguments, span attributes, persisted
 * event data. `Schema.Json` is Effect's recursive JSON union, so a value of
 * this type has already been established as JSON-representable — unlike
 * `unknown`, which asserts nothing and forces every reader to re-guess.
 */
export type Json = Schema.Json;
export type JsonObject = Schema.JsonObject;
export type JsonArray = Schema.JsonArray;

/**
 * A value ready to be serialized: the JSON domain plus the `undefined` that
 * optional struct fields carry and `JSON.stringify` drops. Decoded domain
 * values satisfy it directly, while `Json` rejects them because
 * `exactOptionalPropertyTypes` keeps `undefined` in their property types.
 */
export type JsonSerializable =
  | Json
  | undefined
  | { readonly [key: string]: JsonSerializable }
  | ReadonlyArray<JsonSerializable>;

/** An object whose properties are serializable. See {@link JsonSerializable}. */
export type JsonSerializableObject = { readonly [key: string]: JsonSerializable };

/**
 * A JSON object under construction. Writers fill a draft in place and hand it
 * out as the immutable `JsonObject`, so the mutable index signature stays inside
 * the builder instead of leaking into the read contract.
 */
export type JsonObjectDraft = Record<string, Json>;

export const Json = Schema.Json;
export const JsonObject = Schema.Record(Schema.String, Schema.Json);

/**
 * Decode an inbound payload into the JSON domain. Use this at I/O boundaries —
 * `JSON.parse` output, request bodies, third-party callback arguments — so the
 * `unknown` stops at the boundary instead of travelling inward.
 */
export const decodeJsonObjectOption = Schema.decodeUnknownOption(JsonObject);

/**
 * Coercion from an untyped third-party value into the JSON domain. Values are
 * round-tripped through `JSON.stringify`, so a Date or class instance becomes
 * its JSON projection and anything unserializable becomes its string form.
 * Going through a codec keeps the `unknown` on Effect's side of the boundary and
 * validates the result against `Schema.Json` before it is handed inward.
 */
const JsonFromUnparsed = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Json, {
    decode: SchemaGetter.transform((value) => {
      if (value === undefined) return null;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    }),
    encode: SchemaGetter.transform((value) => value),
  }),
);

/** Coerce an untyped third-party payload into JSON. See {@link JsonFromUnparsed}. */
export const coerceJson = Schema.decodeUnknownSync(JsonFromUnparsed);

/**
 * Coerce an untyped third-party value that is known to denote an object — a
 * generated JSON Schema, a plugin's tool metadata — into the JSON domain. A
 * value that does not project onto a JSON object coerces to an empty object.
 */
export const coerceJsonObject = <A>(value: A): JsonObject => {
  const json = coerceJson(value);
  return isJsonObject(json) ? json : {};
};

/** Parse JSON text — tool output, a template literal, a stored column. */
export const decodeJsonStringOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** Parse JSON text that must denote an object — a serialized JSON Schema, a data part. */
export const decodeJsonObjectStringOption = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));

/**
 * Refinements over an already-decoded JSON value. These narrow within the JSON
 * union rather than guessing at an untyped representation, so callers can branch
 * without assertions.
 */
export const isJsonObject = (value: Json | undefined): value is JsonObject =>
  value !== undefined && Predicate.isObject(value) && !Array.isArray(value);

export const isJsonArray = (value: Json | undefined): value is JsonArray => Array.isArray(value);

export const isJsonString = (value: Json | undefined): value is string => Predicate.isString(value);

export const isJsonNumber = (value: Json | undefined): value is number => Predicate.isNumber(value);

/** Read one property of a JSON value, or `undefined` when it is not an object. */
export const jsonProperty = (value: Json | undefined, key: string): Json | undefined =>
  isJsonObject(value) ? value[key] : undefined;

/** Read a string-typed property, the common case for tagged JSON payloads. */
export const jsonString = (value: Json | undefined, key: string): string | undefined => {
  const property = jsonProperty(value, key);
  return isJsonString(property) ? property : undefined;
};

/** Read a number-typed property. */
export const jsonNumber = (value: Json | undefined, key: string): number | undefined => {
  const property = jsonProperty(value, key);
  return isJsonNumber(property) ? property : undefined;
};

/**
 * Render a JSON value for display or for a text a2a part: strings pass through
 * unquoted, everything else is serialized, and absent values render empty.
 */
export const renderJson = (value: Json | undefined): string => {
  if (value === undefined || value === null) return '';
  return isJsonString(value) ? value : JSON.stringify(value);
};
