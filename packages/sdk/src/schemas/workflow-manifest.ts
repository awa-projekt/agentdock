import * as JsonSchema from 'effect/JsonSchema';
import * as Schema from 'effect/Schema';
import type { InputContract } from './agents';
import { coerceJsonObject, JsonObject, type JsonObjectDraft } from './json';
import { ReasoningEffort } from './reasoning';

/**
 * A workflow artifact is a folder of ordinary LangGraph code plus this manifest:
 *
 *   my-workflow/
 *     agentdock.workflow.json   ← this manifest
 *     package.json + bun.lock   ← the artifact's own dependencies
 *     workflow.ts               ← exports a compiled LangGraph (see `graph`)
 *
 * The code never imports anything from agentdock. Everything the host provides
 * — the durable checkpointer, the agents the workflow may call, run identity —
 * is injected through LangGraph's own runtime context and config at invoke time.
 * The manifest carries what the graph object cannot express by itself: identity,
 * where to find the export, and the dependencies to bind at registration.
 */
export const WorkflowBindingDeclaration = Schema.Struct({
  description: Schema.optional(Schema.String),
});

/**
 * A chat model the workflow's own code calls (a router, a judge, a planner),
 * bound to a platform model (`provider:model`) at registration so it runs on
 * the platform's provider keys and custom providers and is recorded like any
 * agent's model call. `default` binds it when the push names no model for it.
 */
export const WorkflowModelDeclaration = Schema.Struct({
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
  /** How hard the model thinks, whichever model the name is bound to; absent leaves the provider default. */
  reasoningEffort: Schema.optional(ReasoningEffort),
});

export const WorkflowManifest = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,

  /**
   * `<module>:<export>` relative to the folder, e.g. `./workflow.ts:graph`.
   * Defaults to `./workflow.ts:default`. The export is a compiled LangGraph
   * built without a checkpointer, or a function returning one.
   */
  graph: Schema.optional(Schema.String),

  /**
   * JSON Schema for the task input. When omitted it is derived from the graph's
   * declared input schema at registration; a graph built from plain
   * `Annotation`s has none, so state it here to get an input contract.
   */
  input: Schema.optional(JsonObject),

  /** JSON Schema for the final output; derived from the graph's output schema when omitted. */
  output: Schema.optional(JsonObject),

  /**
   * Agents this workflow calls, keyed by the local name the code uses as
   * `context.agents.<name>`. Bound to registered agents or workflows at
   * registration; never a database id.
   */
  agents: Schema.optional(Schema.Record(Schema.String, WorkflowBindingDeclaration)),

  /** Registered workflows this workflow invokes as `context.workflows.<name>`, bound like agents. */
  workflows: Schema.optional(Schema.Record(Schema.String, WorkflowBindingDeclaration)),

  /**
   * Integration tools this workflow calls as `context.tools.<name>`, each a
   * LangChain tool. Bound to a catalog tool at registration by tool name, or
   * by an explicit tool id when the name is ambiguous.
   */
  tools: Schema.optional(Schema.Record(Schema.String, WorkflowBindingDeclaration)),

  /**
   * Chat models the code calls as `context.models.<name>`, each a LangChain
   * chat model. Bound to a platform model at registration: `--bind name=provider:model`,
   * else the declaration's `default`.
   */
  models: Schema.optional(Schema.Record(Schema.String, WorkflowModelDeclaration)),

  /** Secret names the code reads from `context.secrets`; bound by the host at registration. */
  secrets: Schema.optional(Schema.Array(Schema.String)),
});

export type WorkflowManifest = Schema.Schema.Type<typeof WorkflowManifest>;
export type WorkflowBindingDeclaration = Schema.Schema.Type<typeof WorkflowBindingDeclaration>;
export type WorkflowModelDeclaration = Schema.Schema.Type<typeof WorkflowModelDeclaration>;

export const WORKFLOW_MANIFEST_FILENAME = 'agentdock.workflow.json';
export const DEFAULT_WORKFLOW_GRAPH = './workflow.ts:default';

export const decodeWorkflowManifestTextEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowManifest));

export type WorkflowGraphLocation = { readonly module: string; readonly exportName: string };

/** Splits `./workflow.ts:graph` into its module path and export name. */
export const manifestGraphLocation = (manifest: WorkflowManifest): WorkflowGraphLocation => {
  const spec = manifest.graph ?? DEFAULT_WORKFLOW_GRAPH;
  const separator = spec.lastIndexOf(':');
  return separator === -1
    ? { module: spec, exportName: 'default' }
    : { module: spec.slice(0, separator), exportName: spec.slice(separator + 1) || 'default' };
};

export const manifestAgentNames = (manifest: WorkflowManifest): ReadonlyArray<string> =>
  Object.keys(manifest.agents ?? {});

export const manifestWorkflowNames = (manifest: WorkflowManifest): ReadonlyArray<string> =>
  Object.keys(manifest.workflows ?? {});

export const manifestToolNames = (manifest: WorkflowManifest): ReadonlyArray<string> =>
  Object.keys(manifest.tools ?? {});

export const manifestModelNames = (manifest: WorkflowManifest): ReadonlyArray<string> =>
  Object.keys(manifest.models ?? {});

/** The a2a input contract the platform advertises, derived from the manifest's JSON Schema. */
export const manifestInputContract = (manifest: WorkflowManifest): InputContract | undefined =>
  manifest.input ? { name: 'input', schema: JSON.stringify(manifest.input) } : undefined;

/** The manifest contract as JSON Schema, served for `$schema` editor support. */
export const workflowManifestJsonSchema = (): JsonObject => {
  const document = Schema.toJsonSchemaDocument(WorkflowManifest);
  const schema: JsonObjectDraft = {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    title: 'agentdock workflow manifest',
    ...coerceJsonObject(document.schema),
  };
  if (Object.keys(document.definitions).length > 0) {
    schema.$defs = coerceJsonObject(document.definitions);
  }
  return schema;
};
