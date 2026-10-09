import type { Json as JsonValue } from 'agentdock-sdk/schemas';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { JsonView } from '@/components/json-view';
import { MarkdownPreview } from '@/components/markdown';
import { pluralise } from '@/lib/format';
import {
  additionalPropertiesSchema,
  arrayItemSchema,
  deepResolve,
  getTypeLabel,
  type Json,
  jsonSchemaDocument,
  mergeAllOf,
  resolveRef,
  type SchemaTypeKind,
  safeLabel,
  schemaTypeKind,
  schemaTypes,
} from '@/lib/json-schema';
import { cn } from '@/lib/utils';

const getChildCount = (schema: Json, root: Json): number => {
  const current = deepResolve(schema, root);
  if (current.properties) return Object.keys(current.properties).length;
  const items = arrayItemSchema(current);
  if (items) {
    const itemResolved = deepResolve(items, root);
    return itemResolved.properties ? Object.keys(itemResolved.properties).length : 0;
  }
  if (current.allOf) {
    const merged = mergeAllOf(current.allOf, root);
    return merged.properties ? Object.keys(merged.properties).length : 0;
  }
  if (current.oneOf && current.oneOf.length > 1) return current.oneOf.length;
  if (current.anyOf && current.anyOf.length > 1) return current.anyOf.length;
  if (additionalPropertiesSchema(current)) return 1;
  return 0;
};

const isExpandable = (schema: Json, root: Json): boolean => getChildCount(schema, root) > 0;

const isEmptyObjectSchema = (schema: Json, root: Json): boolean => {
  const current = deepResolve(schema, root);
  if (current.const !== undefined || current.enum) return false;
  if (current.allOf || current.oneOf || current.anyOf) return false;
  if (current.items) return false;
  if (additionalPropertiesSchema(current)) return false;
  const types = schemaTypes(current);
  if (types.length === 0) return false;
  if (!types.includes('object')) return false;
  return !current.properties || Object.keys(current.properties).length === 0;
};

const countTopLevelFields = (schema: Json): number => {
  const resolved = deepResolve(schema, schema);
  if (resolved.properties) return Object.keys(resolved.properties).length;
  if (resolved.allOf) {
    const merged = mergeAllOf(resolved.allOf, schema);
    return merged.properties ? Object.keys(merged.properties).length : 0;
  }
  if (resolved.oneOf && resolved.oneOf.length > 1) return resolved.oneOf.length;
  if (resolved.anyOf && resolved.anyOf.length > 1) return resolved.anyOf.length;
  return 0;
};

const typeColor = {
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  boolean: 'text-syntax-keyword',
  structure: 'text-syntax-structure',
  literal: 'text-syntax-literal',
  other: 'text-muted-foreground',
} satisfies Record<SchemaTypeKind, string>;

function PropertyRow({
  name,
  schema,
  root,
  required,
  depth,
  hideRequiredBadge,
}: {
  name: string;
  schema: Json;
  root: Json;
  required: boolean;
  depth: number;
  hideRequiredBadge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = isExpandable(schema, root);
  const description = schema.description ?? (schema.$ref ? resolveRef(schema.$ref, root)?.description : undefined);
  const childSchema = schema.$ref ? (resolveRef(schema.$ref, root) ?? schema) : schema;

  const body = (
    <>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {expandable ? (
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
        ) : (
          <span aria-hidden className="size-1 rounded-full bg-muted-foreground/40" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-mono text-xs font-medium text-syntax-key">{name}</span>
          <span className={cn('font-mono text-[11px]', typeColor[schemaTypeKind(schema)])}>
            {getTypeLabel(schema, root)}
          </span>
          {hideRequiredBadge ? null : (
            <span className={cn('text-[11px]', required ? 'text-primary' : 'text-muted-foreground')}>
              {required ? 'required' : 'optional'}
            </span>
          )}
          {schema.default === undefined ? null : (
            <span className="font-mono text-[11px] text-syntax-literal">= {safeLabel(schema.default)}</span>
          )}
        </span>
        {description ? (
          <MarkdownPreview className="text-xs leading-snug text-muted-foreground">{description}</MarkdownPreview>
        ) : null}
      </span>
    </>
  );

  return (
    <li className="min-w-0">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-2 py-1.5">{body}</div>
      )}
      {open && expandable ? (
        <div className="ml-4 border-l border-border/60 pl-1">
          <PropertyChildren schema={childSchema} root={root} depth={depth + 1} />
        </div>
      ) : null}
    </li>
  );
}

function PropertyChildren({ schema: rawSchema, root, depth }: { schema: Json; root: Json; depth: number }) {
  if (depth > 6) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">Nested too deep to display.</p>;
  }

  const schema = deepResolve(rawSchema, root);
  const required = new Set(schema.required ?? []);

  if (schema.properties && Object.keys(schema.properties).length > 0) {
    const entries = Object.entries(schema.properties).sort(([a], [b]) => {
      const ar = required.has(a);
      const br = required.has(b);
      if (ar !== br) return ar ? -1 : 1;
      return a.localeCompare(b);
    });
    return (
      <ul className="min-w-0">
        {entries.map(([key, value]) => (
          <PropertyRow key={key} name={key} schema={value} root={root} required={required.has(key)} depth={depth} />
        ))}
      </ul>
    );
  }

  const items = arrayItemSchema(schema);
  if (items) {
    const itemResolved = deepResolve(items, root);
    if (itemResolved.properties && Object.keys(itemResolved.properties).length > 0) {
      return <PropertyChildren schema={itemResolved} root={root} depth={depth} />;
    }
    return (
      <ul className="min-w-0">
        <PropertyRow name="items" schema={items} root={root} required depth={depth} hideRequiredBadge />
      </ul>
    );
  }

  if (schema.allOf) {
    const merged = mergeAllOf(schema.allOf, root);
    if (merged.properties && Object.keys(merged.properties).length > 0) {
      return <PropertyChildren schema={merged} root={root} depth={depth} />;
    }
  }

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && variants.length > 1) {
    return (
      <div className="min-w-0">
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {schema.oneOf ? 'One of' : 'Any of'}
        </p>
        <ul className="min-w-0">
          {variants.map((variant, index) => (
            <PropertyRow
              key={variant.title ?? `${index}`}
              name={variant.title ?? `option ${index + 1}`}
              schema={variant}
              root={root}
              required={false}
              depth={depth}
              hideRequiredBadge
            />
          ))}
        </ul>
      </div>
    );
  }

  const additional = additionalPropertiesSchema(schema);
  if (additional) {
    return (
      <ul className="min-w-0">
        <PropertyRow name="[key]" schema={additional} root={root} required depth={depth} hideRequiredBadge />
      </ul>
    );
  }

  return null;
}

function SchemaPanel({ title, summary, children }: { title: string; summary?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 self-start overflow-hidden rounded-lg border border-border bg-background/60">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
        {summary === undefined ? null : (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">{summary}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function SchemaExplorer({
  schema: rawSchema,
  title,
  emptyMessage = 'Not declared.',
}: {
  schema?: JsonValue;
  title: string;
  emptyMessage?: string;
}) {
  const schema = jsonSchemaDocument(rawSchema);

  if (rawSchema === undefined || !schema || isEmptyObjectSchema(schema, schema)) {
    return (
      <SchemaPanel title={title}>
        <p className="px-3 py-2.5 text-xs text-muted-foreground">{emptyMessage}</p>
      </SchemaPanel>
    );
  }

  const fields = countTopLevelFields(schema);
  return (
    <SchemaPanel title={title} summary={fields > 0 ? pluralise(fields, 'field') : getTypeLabel(schema, schema)}>
      {isExpandable(schema, schema) ? (
        <div className="p-1">
          <PropertyChildren schema={schema} root={schema} depth={0} />
        </div>
      ) : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">{schema.description ?? 'No fields.'}</p>
      )}
      <div className="border-t border-border p-1.5">
        <JsonView value={rawSchema} label="raw document" />
      </div>
    </SchemaPanel>
  );
}
