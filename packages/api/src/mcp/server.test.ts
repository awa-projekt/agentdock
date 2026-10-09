import { describe, expect, it } from '@effect/vitest';
import * as Schema from 'effect/Schema';
import { toJsonSchema } from './server';

describe('toJsonSchema', () => {
  it('advertises a struct as a draft-2020-12 object schema', () => {
    const schema = toJsonSchema(Schema.Struct({ agentId: Schema.String, limit: Schema.optional(Schema.Int) }));
    expect(schema.type).toBe('object');
    expect(schema.properties?.agentId).toEqual({ type: 'string' });
    expect(schema.properties?.limit).toBeDefined();
    expect(schema.required).toEqual(['agentId']);
  });

  it('advertises a schema that does not describe an object as taking no arguments', () => {
    expect(toJsonSchema(Schema.Struct({}))).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});
