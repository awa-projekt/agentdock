// Minimal JSON Schema shape and resolution helpers shared by the schema
// explorer (read-only inspection) and the dynamic tool-input form. Tools expose
// OpenAPI-style JSON Schema (`$ref`/`$defs`, `allOf`/`oneOf`/`anyOf`), so both
// surfaces need the same resolver instead of duplicating the walk.

import type { JsonSerializable, Json as JsonValue } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';

export type Json = {
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Record<string, Json>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Json | ReadonlyArray<Json>;
  readonly additionalProperties?: boolean | Json;
  readonly oneOf?: ReadonlyArray<Json>;
  readonly anyOf?: ReadonlyArray<Json>;
  readonly allOf?: ReadonlyArray<Json>;
  readonly enum?: ReadonlyArray<JsonValue>;
  readonly const?: JsonValue;
  readonly $ref?: string;
  readonly $defs?: Record<string, Json>;
  readonly definitions?: Record<string, Json>;
  readonly description?: string;
  readonly title?: string;
  readonly default?: JsonValue;
  readonly format?: string;
};

const Document: Schema.Codec<Json> = Schema.suspend(
  (): Schema.Codec<Json> =>
    Schema.Struct({
      type: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      properties: Schema.optional(Schema.Record(Schema.String, Document)),
      required: Schema.optional(Schema.Array(Schema.String)),
      items: Schema.optional(Schema.Union([Schema.Array(Document), Document])),
      additionalProperties: Schema.optional(Schema.Union([Schema.Boolean, Document])),
      oneOf: Schema.optional(Schema.Array(Document)),
      anyOf: Schema.optional(Schema.Array(Document)),
      allOf: Schema.optional(Schema.Array(Document)),
      enum: Schema.optional(Schema.Array(Schema.Json)),
      const: Schema.optional(Schema.Json),
      $ref: Schema.optional(Schema.String),
      $defs: Schema.optional(Schema.Record(Schema.String, Document)),
      definitions: Schema.optional(Schema.Record(Schema.String, Document)),
      description: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      default: Schema.optional(Schema.Json),
      format: Schema.optional(Schema.String),
    }),
);

const decodeDocument = Schema.decodeUnknownOption(Document);

// The single boundary where an arbitrary JSON payload becomes a schema document.
export const jsonSchemaDocument = (value: JsonSerializable): Json | undefined =>
  Option.getOrUndefined(decodeDocument(value));

const getRefName = (ref: string): string | undefined => ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)?.[1];

export const resolveRef = (ref: string, root: Json): Json | null => {
  const name = getRefName(ref);
  if (!name) return null;
  return root.$defs?.[name] ?? root.definitions?.[name] ?? null;
};

// Collapses `$ref` and single-variant `oneOf`/`anyOf` wrappers down to the
// concrete schema they point at.
export const deepResolve = (schema: Json, root: Json): Json => {
  let current = schema;
  if (current.$ref) {
    const resolved = resolveRef(current.$ref, root);
    if (resolved) current = resolved;
  }
  if (current.oneOf?.length === 1) return deepResolve(current.oneOf[0]!, root);
  if (current.anyOf?.length === 1) return deepResolve(current.anyOf[0]!, root);
  return current;
};

export const mergeAllOf = (schemas: ReadonlyArray<Json>, root: Json): Json => {
  const properties: Record<string, Json> = {};
  const required: Array<string> = [];
  let description: string | undefined;
  for (const entry of schemas) {
    const resolved = deepResolve(entry, root);
    if (resolved.properties) Object.assign(properties, resolved.properties);
    if (resolved.required) required.push(...resolved.required);
    if (resolved.description && !description) description = resolved.description;
  }
  return description ? { type: 'object', properties, required, description } : { type: 'object', properties, required };
};

export const schemaTypes = (schema: Json): ReadonlyArray<string> => {
  const type = schema.type;
  if (Predicate.isString(type)) return [type];
  return type ?? [];
};

const isSchemaList = (items: Json | ReadonlyArray<Json>): items is ReadonlyArray<Json> => Array.isArray(items);

// The schema for every element of an array, absent for tuple-style `items`.
export const arrayItemSchema = (schema: Json): Json | undefined => {
  const items = schema.items;
  return items === undefined || isSchemaList(items) ? undefined : items;
};

// The schema constraining extra properties, absent when it is just a flag.
export const additionalPropertiesSchema = (schema: Json): Json | undefined => {
  const additional = schema.additionalProperties;
  return additional === undefined || Predicate.isBoolean(additional) ? undefined : additional;
};

export const safeLabel = (value: JsonValue): string => {
  const label = JSON.stringify(value);
  return label.length > 120 ? `${label.slice(0, 117)}…` : label;
};

// Renders a concise TypeScript-ish type label for a schema (e.g. `string`,
// `number[]`, `"a" | "b"`, `Record<string, object>`). Shared by the schema
// explorer and the dynamic form so field types read identically in both.
export const getTypeLabel = (schema: Json, root: Json): string => {
  if (schema.$ref) return getRefName(schema.$ref) ?? 'ref';
  if (schema.const !== undefined) return safeLabel(schema.const);

  if (schema.enum) {
    if (schema.enum.length <= 3) return schema.enum.map((value) => safeLabel(value)).join(' | ');
    return `enum (${schema.enum.length})`;
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 1) return getTypeLabel(schema.oneOf[0]!, root);
    const labels = schema.oneOf.slice(0, 3).map((entry) => getTypeLabel(entry, root));
    if (schema.oneOf.length > 3) labels.push('…');
    return labels.join(' | ');
  }

  if (schema.anyOf) {
    if (schema.anyOf.length === 1) return getTypeLabel(schema.anyOf[0]!, root);
    const labels = schema.anyOf.slice(0, 3).map((entry) => getTypeLabel(entry, root));
    if (schema.anyOf.length > 3) labels.push('…');
    return labels.join(' | ');
  }

  if (schema.allOf) {
    for (const entry of schema.allOf) {
      if (entry.$ref) {
        const name = getRefName(entry.$ref);
        if (name) return name;
      }
    }
    return 'object';
  }

  const types = schemaTypes(schema);

  if (types.includes('array')) {
    const items = arrayItemSchema(schema);
    return items ? `${getTypeLabel(items, root)}[]` : 'array';
  }

  if (types.includes('object')) {
    const additional = additionalPropertiesSchema(schema);
    return additional ? `Record<string, ${getTypeLabel(additional, root)}>` : 'object';
  }

  if (types.length === 1) {
    const type = types[0]!;
    if (schema.format) return `${type}<${schema.format}>`;
    return type;
  }
  if (types.length > 1) return types.join(' | ');

  return 'any';
};

export type SchemaTypeKind = 'string' | 'number' | 'boolean' | 'structure' | 'literal' | 'other';

export const schemaTypeKind = (schema: Json): SchemaTypeKind => {
  if (schema.$ref !== undefined || schema.allOf !== undefined) return 'structure';
  if (schema.const !== undefined || schema.enum !== undefined) return 'literal';
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) return 'other';
  const types = schemaTypes(schema);
  if (types.length !== 1) return 'other';
  switch (types[0]) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      return 'structure';
    default:
      return 'other';
  }
};
