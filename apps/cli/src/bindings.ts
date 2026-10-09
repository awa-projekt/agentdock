import { agentOutputSchema } from 'agentdock-sdk';
import type { AgentConfig, CatalogTool, WorkflowManifest } from 'agentdock-sdk/schemas';
import { manifestModelNames } from 'agentdock-sdk/schemas';
import { type WorkflowAgentBinding, workflowToolDefinition } from 'agentdock-sdk/workflows';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type { ApiService } from './api';
import { type CliError, cliError } from './errors';
import type { FileServices } from './files';
import { AGENT_FILE_SUFFIX, AGENTS_DIR, findProject, optionalSetting, readAgentConfigFile, slugify } from './project';
import { listIntegrations } from './remote';

/** Where a manifest agent name resolves to for a local run. */
export type BindingSource =
  | { readonly name: string; readonly kind: 'file'; readonly file: string }
  | { readonly name: string; readonly kind: 'url'; readonly url: string }
  | { readonly name: string; readonly kind: 'unbound'; readonly expected: string };

const isUrl = (value: string): boolean => /^https?:\/\//.test(value);

/**
 * Locates each manifest agent name: an explicit `--agent name=<file|url>` value
 * wins, otherwise `agents/<slug>.agent.yaml` in the project (or the current
 * directory outside one).
 */
export const locateBindings = (
  names: ReadonlyArray<string>,
  values: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<BindingSource>, CliError, FileServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* findProject;
    const agentsDir = Option.match(project, {
      onNone: () => path.resolve(AGENTS_DIR),
      onSome: (found) => path.join(found.root, AGENTS_DIR),
    });
    return yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const value = values[name];
        if (value !== undefined && isUrl(value)) return { name, kind: 'url', url: value } as const;
        const file = value ?? path.join(agentsDir, `${slugify(name)}${AGENT_FILE_SUFFIX}`);
        const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
        return exists ? ({ name, kind: 'file', file } as const) : ({ name, kind: 'unbound', expected: file } as const);
      }),
    );
  });

const internalBinding = (name: string, config: AgentConfig): WorkflowAgentBinding => {
  const outputSchema = agentOutputSchema(config);
  const agent = {
    id: name,
    name: config.name,
    instructions: config.instructions,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    inputContract: config.inputContract ?? null,
  };
  return { name, kind: 'internal', agent: outputSchema ? { ...agent, outputSchema } : agent };
};

export const resolveBindings = (
  names: ReadonlyArray<string>,
  values: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<WorkflowAgentBinding>, CliError, FileServices> =>
  Effect.gen(function* () {
    const sources = yield* locateBindings(names, values);
    const unbound = sources.flatMap((source) => (source.kind === 'unbound' ? [source.name] : []));
    if (unbound.length > 0) {
      return yield* cliError(
        `Unbound agents: ${unbound.join(', ')}. Add agents/<name>.agent.yaml to the project or pass --agent <name>=<file|url>.`,
      );
    }
    return yield* Effect.forEach(sources, (source) => {
      switch (source.kind) {
        case 'url':
          return Effect.succeed<WorkflowAgentBinding>({
            name: source.name,
            kind: 'external',
            id: source.name,
            url: source.url,
          });
        case 'file':
          return Effect.map(readAgentConfigFile(source.file), (config) => internalBinding(source.name, config));
        case 'unbound':
          return Effect.die('unbound bindings are rejected above');
      }
    });
  });

const toolBinding = (name: string, tool: CatalogTool): WorkflowAgentBinding => ({
  name,
  kind: 'tool',
  tool: workflowToolDefinition(tool),
});

/**
 * Binds manifest tool names against the platform's tool catalog the way a push
 * does: an explicit `--tool name=<tool id>` wins, otherwise the name must match
 * exactly one catalog tool. Local runs still execute the tool on the platform.
 */
export const resolveToolBindings = (
  names: ReadonlyArray<string>,
  values: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<WorkflowAgentBinding>, CliError, ApiService> =>
  Effect.gen(function* () {
    if (names.length === 0) return [];
    const { tools } = yield* listIntegrations.pipe(
      Effect.mapError((error) => cliError(`Cannot read the tool catalog needed to bind tools: ${error.message}`)),
    );
    const issues: Array<string> = [];
    const bindings: Array<WorkflowAgentBinding> = [];
    for (const name of names) {
      const explicitId = values[name];
      if (explicitId !== undefined) {
        const tool = tools.find((candidate) => candidate.id === explicitId);
        if (tool) bindings.push(toolBinding(name, tool));
        else issues.push(`tool '${name}': no catalog tool has id '${explicitId}'`);
        continue;
      }
      const matches = tools.filter((candidate) => candidate.name === name);
      if (matches.length === 1 && matches[0]) bindings.push(toolBinding(name, matches[0]));
      else if (matches.length === 0) issues.push(`tool '${name}': no integration exposes a tool named '${name}'`);
      else
        issues.push(
          `tool '${name}': ${matches.length} tools share that name (${matches.map((tool) => tool.id).join(', ')})`,
        );
    }
    if (issues.length > 0) {
      return yield* cliError(`Unbound tools: ${issues.join('; ')}. Pass --tool <name>=<tool id> to pick one.`);
    }
    return bindings;
  });

export const resolveSecrets = (
  names: ReadonlyArray<string>,
  values: Readonly<Record<string, string>>,
): Effect.Effect<Readonly<Record<string, string>>, CliError> =>
  Effect.gen(function* () {
    const secrets: Record<string, string> = {};
    const missing: Array<string> = [];
    for (const name of names) {
      const value = values[name] ?? Option.getOrUndefined(yield* optionalSetting(name));
      if (value === undefined) missing.push(name);
      else secrets[name] = value;
    }
    if (missing.length > 0) {
      return yield* cliError(
        `Missing secrets: ${missing.join(', ')}. Pass --secret <NAME>=<value> or set them in the environment.`,
      );
    }
    return secrets;
  });

export const parseAssignments = (
  values: ReadonlyArray<string>,
  flag: string,
): Effect.Effect<Readonly<Record<string, string>>, CliError> =>
  Effect.gen(function* () {
    const result: Record<string, string> = {};
    for (const value of values) {
      const separator = value.indexOf('=');
      if (separator <= 0) return yield* cliError(`--${flag} expects name=value, got '${value}'.`);
      result[value.slice(0, separator)] = value.slice(separator + 1);
    }
    return result;
  });

/**
 * Binds the manifest's models for a local run: `--model name=provider:model`,
 * else the manifest's default. The local runtime resolves them from the
 * environment's provider keys.
 */
export const resolveModelBindings = (
  manifest: WorkflowManifest,
  values: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<WorkflowAgentBinding>, CliError> => {
  const issues: Array<string> = [];
  const bindings: Array<WorkflowAgentBinding> = [];
  for (const name of manifestModelNames(manifest)) {
    const declaration = manifest.models?.[name];
    const model = values[name] ?? declaration?.default;
    if (model === undefined) issues.push(`model '${name}' has no default`);
    else bindings.push({ name, kind: 'model', model, reasoningEffort: declaration?.reasoningEffort });
  }
  return issues.length > 0
    ? Effect.fail(cliError(`Unbound models: ${issues.join('; ')}. Pass --model <name>=<provider:model>.`))
    : Effect.succeed(bindings);
};
