import type { ExecuteResult, SandboxToolInvoker } from '@executor-js/codemode-core';
import { makeQuickJsExecutor } from '@executor-js/runtime-quickjs';
import { coerceJson, isJsonString, Json, type JsonObject } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';

const executor = makeQuickJsExecutor({ timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 });

export const runScript = (code: string, invoker: SandboxToolInvoker) => executor.execute(code, invoker);

export type CodeModeTool = {
  readonly id: string;
  readonly alias: string;
  readonly name: string;
  readonly description: string;
  readonly decision: 'allow' | 'require_approval';
  readonly inputSchema?: Json | undefined;
};

/**
 * The slice of JSON Schema the tool description renders. Tool schemas arrive
 * from third-party catalogs, so they are parsed once here and every branch
 * below reads a domain value rather than probing the JSON.
 */
const RenderedSchema = Schema.Struct({
  type: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  items: Schema.optional(Json),
  enum: Schema.optional(Schema.Array(Json)),
  anyOf: Schema.optional(Schema.Array(Json)),
  oneOf: Schema.optional(Schema.Array(Json)),
  $ref: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  properties: Schema.optional(Schema.Record(Schema.String, Json)),
  required: Schema.optional(Schema.Array(Schema.String)),
});
type RenderedSchema = typeof RenderedSchema.Type;

const readSchema = Schema.decodeUnknownOption(RenderedSchema);

const rendered = (schema: Json | undefined): RenderedSchema | undefined =>
  schema === undefined ? undefined : Option.getOrUndefined(readSchema(schema));

const schemaTypeOf = (schema: Json | undefined): string => {
  const parsed = rendered(schema);
  if (parsed === undefined) return 'unknown';
  const { type } = parsed;
  if (Predicate.isString(type)) return type === 'array' ? `${schemaTypeOf(parsed.items)}[]` : type;
  if (type !== undefined) return type.join(' | ');
  if (parsed.enum !== undefined) return parsed.enum.map((entry) => JSON.stringify(entry)).join(' | ');
  const union = parsed.anyOf ?? parsed.oneOf;
  if (union !== undefined) return union.map(schemaTypeOf).join(' | ');
  return parsed.$ref === undefined ? 'unknown' : 'object';
};

const summarizeArguments = (schema: Json | undefined): string => {
  const parsed = rendered(schema);
  const properties = parsed?.properties;
  if (properties === undefined) return 'args?: object';
  const required = new Set(parsed?.required ?? []);
  const fields = Object.entries(properties).map(([name, property]) => {
    const optional = required.has(name) ? '' : '?';
    const description = rendered(property)?.description;
    const comment = description === undefined ? '' : ` /* ${description} */`;
    return `${name}${optional}: ${schemaTypeOf(property)}${comment}`;
  });
  return fields.length === 0 ? 'args?: {}' : `args: { ${fields.join('; ')} }`;
};

/**
 * The `executeTs` tool description: how the sandbox works plus the tools the
 * agent can reach from inside it, grouped by connection alias.
 */
export const buildCodeModeDescription = (tools: ReadonlyArray<CodeModeTool>): string => {
  const byAlias = new Map<string, Array<CodeModeTool>>();
  for (const tool of tools) {
    const group = byAlias.get(tool.alias) ?? [];
    group.push(tool);
    byAlias.set(tool.alias, group);
  }
  const listing = [...byAlias.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, group]) =>
      [
        `tools.${alias}:`,
        ...group
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(
            (tool) =>
              `  - await tools.${alias}.${tool.name}(${summarizeArguments(tool.inputSchema)})${
                tool.decision === 'require_approval' ? ' [needs approval]' : ''
              }\n    ${tool.description.trim().split('\n')[0] ?? ''}`,
          ),
      ].join('\n'),
    )
    .join('\n');
  return [
    'Runs TypeScript in a sandbox with async access to integration tools. Write the body of an async function:',
    'call tools with `await tools.<alias>.<tool>(args)`, use `console.log` for diagnostics, and `return` the value',
    'you want back. Combine several tool calls in one script instead of calling tools one by one. There is no',
    'network access besides the tools listed here. A tool marked [needs approval] throws an error naming an',
    'approvalId the first time it is called; tell the user what needs approval and run the script again once',
    'they decided.',
    '',
    'Reachable tools:',
    listing,
  ].join('\n');
};

/**
 * The runtime reports a script error as its message followed by sandbox and
 * host stack frames; only the message means anything to the model.
 */
const errorMessage = (error: string): string => {
  const frames = error.search(/\n\s+at /);
  return frames === -1 ? error : error.slice(0, frames);
};

const outputText = (result: ExecuteResult): string => {
  if (result.error !== undefined) return errorMessage(result.error);
  const value = coerceJson(result.result);
  if (value === null) return 'null';
  return isJsonString(value) ? value : JSON.stringify(value, null, 2);
};

/** The shape the chat renderer unwraps: `text` for the model, `structured` for the inspector. */
export const formatExecuteResult = (result: ExecuteResult): JsonObject => {
  const structured = { result: coerceJson(result.result), logs: result.logs ?? [] };
  return {
    text: outputText(result),
    structured: result.output === undefined ? structured : { ...structured, output: coerceJson(result.output) },
    isError: result.error !== undefined,
  };
};
