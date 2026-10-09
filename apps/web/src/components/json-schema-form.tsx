import {
  coerceJson,
  decodeJsonStringOption,
  isJsonArray,
  isJsonObject,
  type JsonObjectDraft,
  type JsonSerializable,
  type Json as JsonValue,
  renderJson,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { tryFormatJson } from '@/lib/format';
import {
  arrayItemSchema,
  deepResolve,
  getTypeLabel,
  type Json,
  jsonSchemaDocument,
  mergeAllOf,
  schemaTypes,
} from '@/lib/json-schema';
import { cn } from '@/lib/utils';

const typeLabelClass = 'font-mono text-[11px] leading-5 text-muted-foreground';

// A dynamic, controlled form rendered from a tool's JSON input schema. The whole
// form value lives in the parent as one JSON value (typically an object); each
// field reads its slice and emits a replacement. Constructs we can't render as a
// native control (multi-variant oneOf/anyOf, untyped schemas) fall back to a raw
// JSON editor so every tool stays invokable.

const REQUIRED_LABEL = <span className="text-[10px] font-medium uppercase tracking-wide text-primary">required</span>;

const isObjectSchema = (schema: Json): boolean => {
  if (schema.properties) return true;
  if (schema.allOf) return true;
  return schemaTypes(schema).includes('object');
};

// Seed a value tree from the schema's defaults so the form opens pre-filled.
// Only required props (and anything with an explicit default) are seeded, so
// optional fields stay omitted until the user touches them.
export const initialValueForSchema = (rawSchema: Json | undefined, root: Json): JsonValue => {
  if (!rawSchema) return {};
  const schema = deepResolve(rawSchema, root);
  if (schema.default !== undefined) return schema.default;
  const merged = schema.allOf ? mergeAllOf(schema.allOf, root) : schema;
  if (isObjectSchema(merged) && merged.properties) {
    const required = new Set(merged.required ?? []);
    const out: JsonObjectDraft = {};
    for (const [key, child] of Object.entries(merged.properties)) {
      const resolved = deepResolve(child, root);
      if (resolved.default !== undefined) out[key] = resolved.default;
      else if (required.has(key)) {
        const seeded = seedRequired(resolved, root);
        if (seeded !== undefined) out[key] = seeded;
      }
    }
    return out;
  }
  return {};
};

const seedRequired = (schema: Json, root: Json): JsonValue | undefined => {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return undefined;
  const types = schemaTypes(schema);
  if (types.includes('boolean')) return false;
  if (types.includes('object')) return initialValueForSchema(schema, root);
  return undefined;
};

function FieldShell({
  name,
  typeLabel,
  required,
  description,
  children,
}: {
  name?: string | undefined;
  typeLabel?: string | undefined;
  required?: boolean | undefined;
  description?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      {name ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs font-medium text-foreground">{name}</span>
          {typeLabel ? <span className={typeLabelClass}>{typeLabel}</span> : null}
          {required ? (
            REQUIRED_LABEL
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">optional</span>
          )}
        </div>
      ) : null}
      {children}
      {description ? <p className="text-[11px] leading-snug text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function JsonField({
  value,
  onChange,
}: {
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Textarea
        value={text}
        spellCheck={false}
        className="min-h-24 font-mono text-xs"
        placeholder="JSON value"
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === '') {
            setError(null);
            onChange(undefined);
            return;
          }
          const parsed = decodeJsonStringOption(next);
          if (Option.isNone(parsed)) {
            setError('Invalid JSON');
            return;
          }
          onChange(parsed.value);
          setError(null);
        }}
        onBlur={() => setText((current) => tryFormatJson(current))}
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function ArrayField({
  schema,
  root,
  value,
  onChange,
}: {
  schema: Json;
  root: Json;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const items = isJsonArray(value) ? value : [];
  const itemSchema = arrayItemSchema(schema);

  const setItem = (index: number, next: JsonValue | undefined) => {
    const copy = [...items];
    if (next === undefined) copy.splice(index, 1);
    else copy[index] = next;
    onChange(copy.length === 0 ? undefined : copy);
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <SchemaField
              schema={itemSchema ?? {}}
              root={root}
              value={item}
              required
              onChange={(next) => setItem(index, next)}
            />
          </div>
          <Button
            variant="destructiveGhost"
            size="icon-sm"
            className="mt-1"
            onClick={() => setItem(index, undefined)}
            title="Remove item"
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="border-dashed text-muted-foreground"
        onClick={() => onChange([...items, initialValueForSchema(itemSchema, root)])}
      >
        <Plus />
        Add item
      </Button>
    </div>
  );
}

function SchemaField({
  schema: rawSchema,
  root,
  name,
  required,
  value,
  onChange,
}: {
  schema: Json;
  root: Json;
  name?: string;
  required?: boolean;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const schema = deepResolve(rawSchema, root);
  const description = schema.description;
  const types = schemaTypes(schema);
  const typeLabel = getTypeLabel(schema, root);

  // enum -> select
  const options = schema.enum;
  if (options && options.length > 0) {
    const current = value === undefined ? '' : String(value);
    return (
      <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
        <Select
          value={current}
          onValueChange={(next) =>
            onChange(next === '' ? undefined : (options.find((option) => String(option) === next) ?? next))
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a value" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }

  // multi-variant oneOf/anyOf, or untyped -> raw JSON fallback
  const variants = schema.oneOf ?? schema.anyOf;
  if ((variants && variants.length > 1) || (types.length === 0 && !schema.allOf && !schema.properties)) {
    return (
      <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
        <JsonField value={value} onChange={onChange} />
      </FieldShell>
    );
  }

  // object (incl. allOf composition)
  const merged = schema.allOf ? mergeAllOf(schema.allOf, root) : schema;
  if (isObjectSchema(merged)) {
    const properties = merged.properties ?? {};
    const propRequired = new Set(merged.required ?? []);
    const record = isJsonObject(value) ? value : {};
    const setProp = (key: string, next: JsonValue | undefined) => {
      const copy: JsonObjectDraft = { ...record };
      if (next === undefined) delete copy[key];
      else copy[key] = next;
      onChange(Object.keys(copy).length === 0 ? (required ? {} : undefined) : copy);
    };
    const entries = Object.entries(properties).sort(([a], [b]) => {
      const ar = propRequired.has(a);
      const br = propRequired.has(b);
      if (ar !== br) return ar ? -1 : 1;
      return a.localeCompare(b);
    });

    if (entries.length === 0) {
      // free-form object with no declared properties
      return (
        <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
          <JsonField value={value} onChange={onChange} />
        </FieldShell>
      );
    }

    const body = (
      <div className={cn('space-y-3', name && 'rounded-lg border border-border/70 bg-muted/10 p-3')}>
        {entries.map(([key, child]) => (
          <SchemaField
            key={key}
            schema={child}
            root={root}
            name={key}
            required={propRequired.has(key)}
            value={record[key]}
            onChange={(next) => setProp(key, next)}
          />
        ))}
      </div>
    );

    return name ? (
      <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
        {body}
      </FieldShell>
    ) : (
      body
    );
  }

  // array
  if (types.includes('array')) {
    return (
      <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
        <ArrayField schema={schema} root={root} value={value} onChange={onChange} />
      </FieldShell>
    );
  }

  // boolean
  if (types.includes('boolean')) {
    return (
      <FieldShell required={required} description={description}>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          <span className="font-mono text-xs font-medium text-foreground">{name}</span>
          <span className={typeLabelClass}>{typeLabel}</span>
          {required ? REQUIRED_LABEL : null}
        </label>
      </FieldShell>
    );
  }

  // number / integer
  if (types.includes('number') || types.includes('integer')) {
    const current = Predicate.isNumber(value) || Predicate.isString(value) ? String(value) : '';
    return (
      <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
        <Input
          type="number"
          value={current}
          placeholder={schema.default !== undefined ? String(schema.default) : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') return onChange(undefined);
            const parsed = Number(raw);
            onChange(Number.isNaN(parsed) ? raw : parsed);
          }}
        />
      </FieldShell>
    );
  }

  // string (default)
  return (
    <FieldShell name={name} typeLabel={typeLabel} required={required} description={description}>
      <Input
        value={renderJson(value)}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' && !required ? undefined : raw);
        }}
      />
    </FieldShell>
  );
}

export function JsonSchemaForm({
  schema: rawSchema,
  value,
  onChange,
}: {
  schema: JsonSerializable;
  value: unknown;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const schema = jsonSchemaDocument(rawSchema);
  const current = value === undefined ? undefined : coerceJson(value);

  // Seed defaults once when the schema first becomes available.
  useEffect(() => {
    if (schema && value === undefined) onChange(initialValueForSchema(schema, schema));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!schema) {
    return <JsonField value={current} onChange={onChange} />;
  }

  return <SchemaField schema={schema} root={schema} value={current} onChange={onChange} required />;
}
