import type { JsonObject, WorkflowGraph } from 'agentdock-sdk/schemas';
import {
  manifestAgentNames,
  manifestModelNames,
  manifestToolNames,
  manifestWorkflowNames,
  renderJson,
} from 'agentdock-sdk/schemas';
import {
  extractWorkflowContracts,
  extractWorkflowGraph,
  importWorkflowGraph,
  loadWorkflowManifest,
} from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import { type BindingSource, locateBindings } from '../bindings';
import { type CliError, cliError } from '../errors';
import type { FileServices } from '../files';
import { jsonFlag, writeJson } from '../output';
import { localWorkflowFolders, optionalSetting, requireProject } from '../project';

const folders = Argument.String('folders').pipe(
  Argument.variadic(),
  Argument.withDescription('Workflow artifact folders; every workflow in the project when omitted'),
);

type ContractSource = 'manifest' | 'graph' | 'none';

type Report = {
  readonly folder: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly graph: { readonly module: string; readonly exportName: string };
  readonly sourceHash: string;
  readonly input: { readonly source: ContractSource; readonly schema: JsonObject | null };
  readonly output: { readonly source: ContractSource; readonly schema: JsonObject | null };
  readonly topology: WorkflowGraph;
  readonly agents: ReadonlyArray<BindingSource>;
  readonly workflows: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  /** Each manifest model and the platform model it binds to by default, `null` without a default. */
  readonly models: ReadonlyArray<{ readonly name: string; readonly default: string | null }>;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly set: boolean }>;
  readonly warnings: ReadonlyArray<string>;
};

type Outcome =
  | { readonly ok: true; readonly report: Report }
  | { readonly ok: false; readonly folder: string; readonly error: string };

const contract = (
  declared: JsonObject | undefined,
  derived: JsonObject | undefined,
): { readonly source: ContractSource; readonly schema: JsonObject | null } =>
  declared
    ? { source: 'manifest', schema: declared }
    : derived
      ? { source: 'graph', schema: derived }
      : { source: 'none', schema: null };

const inspect = (folder: string): Effect.Effect<Report, CliError, FileServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadWorkflowManifest(folder);
    const compiled = yield* importWorkflowGraph(loaded);
    const topology = yield* extractWorkflowGraph(compiled, loaded.manifest.name);
    const contracts = extractWorkflowContracts(compiled);
    const { manifest } = loaded;
    const agents = yield* locateBindings(manifestAgentNames(manifest), {});
    const workflows = manifestWorkflowNames(manifest);
    const tools = manifestToolNames(manifest);
    const models = manifestModelNames(manifest).map((name) => ({
      name,
      default: manifest.models?.[name]?.default ?? null,
    }));
    const secrets = yield* Effect.forEach(manifest.secrets ?? [], (name) =>
      Effect.map(optionalSetting(name), (value) => ({ name, set: Option.isSome(value) })),
    );

    const warnings: Array<string> = [];
    if (!loaded.package.hasLockfile) {
      warnings.push(
        'no bun.lock: run `bun install --omit=peer` in the folder so the server installs the same versions',
      );
    }
    if (contracts.input === undefined && manifest.input === undefined) {
      warnings.push(
        'no input contract: any task is accepted and its content reaches the graph as-is; declare an input schema on the graph or `input` in the manifest',
      );
    }
    for (const agent of agents) {
      if (agent.kind === 'unbound')
        warnings.push(
          `agent '${agent.name}' has no local config at ${agent.expected}; local runs need --agent ${agent.name}=<file|url>`,
        );
    }
    if (workflows.length > 0)
      warnings.push(`declares workflows (${workflows.join(', ')}): local runs cannot bind workflows yet`);
    if (tools.length > 0)
      warnings.push(
        `declares tools (${tools.join(', ')}): bound by name against the server's tool catalog; local runs call them on the server and take --tool <name>=<tool id> when a name is ambiguous`,
      );
    for (const model of models) {
      if (model.default === null)
        warnings.push(
          `model '${model.name}' has no default: pushes need --bind ${model.name}=<provider:model>, local runs --model ${model.name}=<provider:model>`,
        );
    }
    for (const secret of secrets) {
      if (!secret.set)
        warnings.push(
          `secret ${secret.name} is not set in the environment; local runs need --secret ${secret.name}=<value>`,
        );
    }

    return {
      folder: loaded.folder,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      graph: loaded.graph,
      sourceHash: loaded.sourceHash,
      input: contract(manifest.input, contracts.input),
      output: contract(manifest.output, contracts.output),
      topology,
      agents,
      workflows,
      tools,
      models,
      secrets,
      warnings,
    };
  }).pipe(Effect.mapError((error) => cliError(error.message)));

const formatList = (values: ReadonlyArray<string>): string => (values.length === 0 ? 'none' : values.join(', '));

const describeBinding = (source: BindingSource): string => {
  switch (source.kind) {
    case 'file':
      return `${source.name} -> ${source.file}`;
    case 'url':
      return `${source.name} -> ${source.url}`;
    case 'unbound':
      return `${source.name} -> unbound`;
  }
};

const printReport = (report: Report, cwd: string, path: Path.Path) =>
  Effect.gen(function* () {
    const steps = report.topology.nodes.filter((node) => node.kind === 'step');
    yield* Console.log(`${report.name} v${report.version} — ${report.description}`);
    yield* Console.log(`  folder:       ${path.relative(cwd, report.folder) || '.'}`);
    yield* Console.log(`  graph:        ${report.graph.module}:${report.graph.exportName}`);
    yield* Console.log(`  source hash:  ${report.sourceHash}`);
    yield* Console.log(`  agents:       ${formatList(report.agents.map(describeBinding))}`);
    yield* Console.log(`  workflows:    ${formatList(report.workflows)}`);
    yield* Console.log(`  tools:        ${formatList(report.tools)}`);
    yield* Console.log(
      `  models:       ${formatList(report.models.map((model) => `${model.name} -> ${model.default ?? 'unbound'}`))}`,
    );
    yield* Console.log(
      `  secrets:      ${formatList(report.secrets.map((s) => `${s.name}${s.set ? '' : ' (unset)'}`))}`,
    );
    yield* Console.log(
      `  input:        ${report.input.source}${report.input.schema ? `  ${renderJson(report.input.schema)}` : ''}`,
    );
    yield* Console.log(
      `  output:       ${report.output.source}${report.output.schema ? `  ${renderJson(report.output.schema)}` : ''}`,
    );
    yield* Console.log(`  steps:        ${formatList(steps.map((node) => node.id))}`);
    for (const edge of report.topology.edges) {
      const label = edge.conditional ? `  (branch${edge.label ? `: ${edge.label}` : ''})` : '';
      yield* Console.log(`    ${edge.source} -> ${edge.target}${label}`);
    }
    for (const warning of report.warnings) yield* Console.log(`  warning:      ${warning}`);
  });

const targets = (given: ReadonlyArray<string>) =>
  given.length > 0
    ? Effect.succeed(given)
    : Effect.gen(function* () {
        const project = yield* requireProject;
        const local = yield* localWorkflowFolders(project);
        if (local.length === 0) return yield* cliError(`No workflows under ${project.root}/workflows.`);
        return local.map((workflow) => workflow.folder);
      });

const check = (given: ReadonlyArray<string>, json: boolean) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cwd = process.cwd();
    const outcomes: Array<Outcome> = yield* Effect.forEach(yield* targets(given), (folder) =>
      inspect(folder).pipe(
        Effect.map((report): Outcome => ({ ok: true, report })),
        Effect.catchTag('CliError', (error) => Effect.succeed<Outcome>({ ok: false, folder, error: error.message })),
      ),
    );

    if (json) {
      writeJson(
        outcomes.map((outcome) => (outcome.ok ? outcome.report : { folder: outcome.folder, error: outcome.error })),
      );
    } else {
      for (const [index, outcome] of outcomes.entries()) {
        if (index > 0) yield* Console.log('');
        if (outcome.ok) yield* printReport(outcome.report, cwd, path);
        else yield* Console.log(`${path.relative(cwd, outcome.folder) || '.'}: ${outcome.error}`);
      }
    }

    const failed = outcomes.filter((outcome) => !outcome.ok);
    if (failed.length > 0)
      return yield* cliError(`${failed.length} of ${outcomes.length} workflow(s) failed validation.`);
  });

export const checkCommand = Command.make('check', { folders, json: jsonFlag }, ({ folders, json }) =>
  check(folders, json),
).pipe(Command.withDescription('Validate workflow folders and report their contracts, topology and bindings'));
