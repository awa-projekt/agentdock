import { decodeJsonStringOption, isJsonObject, type Json as JsonValue } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import type { JsonSchema } from 'jsonjoy-builder';
import { lazy, Suspense } from 'react';

import { JsonTextarea } from '@/components/json-textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const JsonJoySchemaEditor = lazy(() =>
  import('@/components/json-schema-editor-jsonjoy').then((module) => ({ default: module.JsonJoySchemaEditor })),
);

const objectSchema = {
  type: 'object',
  properties: {},
} satisfies JsonSchema;

const formatSchema = (schema: JsonSchema): string => JSON.stringify(schema, null, 2);

type ParsedSchema = {
  readonly schema: JsonSchema | null;
  readonly error: string | null;
};

// A JSON Schema document is either a boolean or an object; jsonjoy-builder
// reads the keywords it recognises and ignores the rest.
const isSchemaDocument = (value: JsonValue): value is JsonSchema & JsonValue =>
  Predicate.isBoolean(value) || isJsonObject(value);

const parseSchema = (value: string): ParsedSchema => {
  const trimmed = value.trim();
  if (!trimmed) return { schema: null, error: null };

  const parsed = decodeJsonStringOption(trimmed);
  if (Option.isNone(parsed)) return { schema: null, error: 'Not valid JSON.' };
  if (!isSchemaDocument(parsed.value)) return { schema: null, error: 'JSON Schema must be an object or boolean.' };
  return { schema: parsed.value, error: null };
};

export const isValidJsonSchemaValue = (value: string): boolean => parseSchema(value).error === null;

export function JsonSchemaEditor({
  id,
  value,
  onChange,
  className,
  defaultSchema = objectSchema,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  emptyLabel?: string;
  emptyDescription?: string;
  defaultSchema?: JsonSchema;
}) {
  const { schema, error } = parseSchema(value);

  if (!schema) {
    if (!value.trim()) {
      return (
        <Suspense
          fallback={
            <div
              id={id}
              className={cn('agentdock-schema-editor min-h-48 rounded-lg border border-border bg-muted/10', className)}
            />
          }
        >
          <JsonJoySchemaEditor id={id} value={value} schema={defaultSchema} onChange={onChange} className={className} />
        </Suspense>
      );
    }

    return (
      <div id={id} className={cn('space-y-2', className)}>
        <JsonTextarea value={value} onChange={onChange} className="min-h-40 text-xs" aria-invalid={true} />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(formatSchema(defaultSchema))}>
          Reset to visual schema
        </Button>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <JsonTextarea id={id} value={value} onChange={onChange} className={cn('min-h-40 text-xs', className)} />
      }
    >
      <JsonJoySchemaEditor id={id} value={value} schema={schema} onChange={onChange} className={className} />
    </Suspense>
  );
}
