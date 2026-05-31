import { ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

type JsonSchema = {
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchema | ReadonlyArray<JsonSchema>;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly oneOf?: ReadonlyArray<JsonSchema>;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly allOf?: ReadonlyArray<JsonSchema>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly const?: unknown;
  readonly $ref?: string;
  readonly $defs?: Record<string, JsonSchema>;
  readonly definitions?: Record<string, JsonSchema>;
  readonly description?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly format?: string;
};

const safeLabel = (value: unknown): string => {
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    const label = JSON.stringify(value);
    if (label === undefined) return String(value);
    return label.length > 120 ? `${label.slice(0, 117)}…` : label;
  } catch {
    return "[unavailable]";
  }
};

const getRefName = (ref: string): string | undefined =>
  ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)?.[1];

const resolveRef = (ref: string, root: JsonSchema): JsonSchema | null => {
  const name = getRefName(ref);
  if (!name) return null;
  return root.$defs?.[name] ?? root.definitions?.[name] ?? null;
};

const deepResolve = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  let current = schema;
  if (current.$ref) {
    const resolved = resolveRef(current.$ref, root);
    if (resolved) current = resolved;
  }
  if (current.oneOf?.length === 1) return deepResolve(current.oneOf[0]!, root);
  if (current.anyOf?.length === 1) return deepResolve(current.anyOf[0]!, root);
  return current;
};

const mergeAllOf = (schemas: ReadonlyArray<JsonSchema>, root: JsonSchema): JsonSchema => {
  const properties: Record<string, JsonSchema> = {};
  const required: Array<string> = [];
  let description: string | undefined;
  for (const entry of schemas) {
    const resolved = deepResolve(entry, root);
    if (resolved.properties) Object.assign(properties, resolved.properties);
    if (resolved.required) required.push(...resolved.required);
    if (resolved.description && !description) description = resolved.description;
  }
  return description
    ? { type: "object", properties, required, description }
    : { type: "object", properties, required };
};

const getTypeLabel = (schema: JsonSchema, root: JsonSchema): string => {
  if (schema.$ref) return getRefName(schema.$ref) ?? "ref";
  if (schema.const !== undefined) return safeLabel(schema.const);

  if (schema.enum) {
    if (schema.enum.length <= 3) return schema.enum.map((value) => safeLabel(value)).join(" | ");
    return `enum (${schema.enum.length})`;
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 1) return getTypeLabel(schema.oneOf[0]!, root);
    const labels = schema.oneOf.slice(0, 3).map((entry) => getTypeLabel(entry, root));
    if (schema.oneOf.length > 3) labels.push("…");
    return labels.join(" | ");
  }

  if (schema.anyOf) {
    if (schema.anyOf.length === 1) return getTypeLabel(schema.anyOf[0]!, root);
    const labels = schema.anyOf.slice(0, 3).map((entry) => getTypeLabel(entry, root));
    if (schema.anyOf.length > 3) labels.push("…");
    return labels.join(" | ");
  }

  if (schema.allOf) {
    for (const entry of schema.allOf) {
      if (entry.$ref) {
        const name = getRefName(entry.$ref);
        if (name) return name;
      }
    }
    return "object";
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (types.includes("array")) {
    const items = schema.items;
    if (items && !Array.isArray(items)) {
      return `${getTypeLabel(items as JsonSchema, root)}[]`;
    }
    return "array";
  }

  if (types.includes("object")) {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `Record<string, ${getTypeLabel(schema.additionalProperties, root)}>`;
    }
    return "object";
  }

  if (types.length === 1) {
    const type = types[0]!;
    if (schema.format) return `${type}<${schema.format}>`;
    return type;
  }
  if (types.length > 1) return types.join(" | ");

  return "any";
};

const getChildCount = (schema: JsonSchema, root: JsonSchema): number => {
  const current = deepResolve(schema, root);
  if (current.properties) return Object.keys(current.properties).length;
  if (current.items && !Array.isArray(current.items)) {
    const itemResolved = deepResolve(current.items as JsonSchema, root);
    if (itemResolved.properties) return Object.keys(itemResolved.properties).length;
    return 0;
  }
  if (current.allOf) {
    const merged = mergeAllOf(current.allOf, root);
    return merged.properties ? Object.keys(merged.properties).length : 0;
  }
  if (current.oneOf && current.oneOf.length > 1) return current.oneOf.length;
  if (current.anyOf && current.anyOf.length > 1) return current.anyOf.length;
  if (current.additionalProperties && typeof current.additionalProperties === "object") return 1;
  return 0;
};

const isExpandable = (schema: JsonSchema, root: JsonSchema): boolean =>
  getChildCount(schema, root) > 0;

const isEmptyObjectSchema = (schema: JsonSchema, root: JsonSchema): boolean => {
  const current = deepResolve(schema, root);
  if (current.const !== undefined || current.enum) return false;
  if (current.allOf || current.oneOf || current.anyOf) return false;
  if (current.items) return false;
  if (current.additionalProperties && typeof current.additionalProperties === "object") return false;
  const types = Array.isArray(current.type) ? current.type : current.type ? [current.type] : [];
  if (types.length === 0) return false;
  if (!types.includes("object")) return false;
  return !current.properties || Object.keys(current.properties).length === 0;
};

const countTopLevelFields = (schema: JsonSchema): number => {
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

const typeLabelClass = "font-mono text-[11px] leading-5 text-muted-foreground";

function PropertyRow({
  name,
  schema,
  root,
  required,
  depth,
  hideRequiredBadge,
}: {
  name: string;
  schema: JsonSchema;
  root: JsonSchema;
  required: boolean;
  depth: number;
  hideRequiredBadge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<JsonSchema | null>(null);

  const expandable = isExpandable(schema, root);
  const typeLabel = getTypeLabel(schema, root);
  const description =
    schema.description ??
    (schema.$ref ? resolveRef(schema.$ref, root)?.description : undefined);

  const handleToggle = useCallback(() => {
    if (!open && !resolved && schema.$ref) {
      setResolved(resolveRef(schema.$ref, root));
    }
    setOpen((value) => !value);
  }, [open, resolved, schema, root]);

  const childSchema = schema.$ref ? (resolved ?? resolveRef(schema.$ref, root) ?? schema) : schema;

  return (
    <div>
      <div
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        onClick={expandable ? handleToggle : undefined}
        onKeyDown={
          expandable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleToggle();
                }
              }
            : undefined
        }
        className={cn(
          "flex items-start gap-2 px-3 py-2",
          expandable && "cursor-pointer transition-colors hover:bg-accent/40",
        )}
        style={depth > 0 ? { paddingLeft: `${depth * 14 + 12}px` } : undefined}
      >
        <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {expandable ? (
            <ChevronRight
              className="size-3 text-muted-foreground transition-transform duration-150"
              style={open ? { transform: "rotate(90deg)" } : undefined}
            />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-[12px] font-medium text-foreground">{name}</span>
          <span className={typeLabelClass}>{typeLabel}</span>
          {!hideRequiredBadge &&
            (required ? (
              <span className="text-[10px] font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
                required
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                optional
              </span>
            ))}
          {schema.default !== undefined ? (
            <span className="text-[11px] text-muted-foreground">
              = {safeLabel(schema.default)}
            </span>
          ) : null}
        </div>
      </div>

      {description ? (
        <p
          className="pr-3 pb-2 text-[11px] leading-snug text-muted-foreground"
          style={{ paddingLeft: `${depth * 14 + 30}px` }}
        >
          {description}
        </p>
      ) : null}

      {open && expandable ? (
        <div
          className="border-l border-border/50"
          style={{ marginLeft: `${depth * 14 + 18}px` }}
        >
          <PropertyChildren schema={childSchema} root={root} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  );
}

function PropertyChildren({
  schema: rawSchema,
  root,
  depth,
}: {
  schema: JsonSchema;
  root: JsonSchema;
  depth: number;
}) {
  if (depth > 6) {
    return <p className="px-3 py-2 text-[11px] text-muted-foreground">Nested too deep to display.</p>;
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
      <div className="divide-y divide-border/40">
        {entries.map(([key, value]) => (
          <PropertyRow
            key={key}
            name={key}
            schema={value}
            root={root}
            required={required.has(key)}
            depth={depth}
          />
        ))}
      </div>
    );
  }

  if (schema.items && !Array.isArray(schema.items)) {
    const itemSchema = deepResolve(schema.items as JsonSchema, root);
    if (itemSchema.properties && Object.keys(itemSchema.properties).length > 0) {
      return <PropertyChildren schema={itemSchema} root={root} depth={depth} />;
    }
    return <PropertyRow name="items" schema={schema.items as JsonSchema} root={root} required depth={depth} />;
  }

  if (schema.allOf) {
    const merged = mergeAllOf(schema.allOf, root);
    if (merged.properties && Object.keys(merged.properties).length > 0) {
      return <PropertyChildren schema={merged} root={root} depth={depth} />;
    }
  }

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && variants.length > 1) {
    const label = schema.oneOf ? "One of" : "Any of";
    return (
      <div>
        <p
          className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground"
          style={depth > 0 ? { paddingLeft: `${depth * 14 + 12}px` } : undefined}
        >
          {label}
        </p>
        <div className="divide-y divide-border/40">
          {variants.map((variant, index) => (
            <PropertyRow
              key={index}
              name={variant.title ?? `option ${index + 1}`}
              schema={variant}
              root={root}
              required={false}
              depth={depth}
              hideRequiredBadge
            />
          ))}
        </div>
      </div>
    );
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return (
      <PropertyRow
        name="[key]"
        schema={schema.additionalProperties}
        root={root}
        required
        depth={depth}
      />
    );
  }

  return null;
}

export function SchemaExplorer({
  schema: rawSchema,
  title,
  emptyMessage = "None",
}: {
  schema: unknown;
  title?: string;
  emptyMessage?: string;
}) {
  const schema = (rawSchema ?? undefined) as JsonSchema | undefined;

  if (!schema || isEmptyObjectSchema(schema, schema)) {
    return (
      <div className="overflow-hidden rounded-md border border-border/60">
        {title ? (
          <div className="border-b border-border/40 bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </div>
        ) : null}
        <p className="px-3 py-2 text-[11px] text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  const expandable = isExpandable(schema, schema);
  const fieldCount = countTopLevelFields(schema);
  const countLabel = fieldCount > 0 ? `${fieldCount} ${fieldCount === 1 ? "field" : "fields"}` : null;

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/40 px-3 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {countLabel ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {countLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      {expandable ? (
        <PropertyChildren schema={schema} root={schema} depth={0} />
      ) : (
        <div className="px-3 py-2">
          <span className={typeLabelClass}>{getTypeLabel(schema, schema)}</span>
        </div>
      )}
    </div>
  );
}
