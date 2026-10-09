import { WORKFLOW_MANIFEST_FILENAME, WorkflowManifest } from 'agentdock-sdk/schemas';
import { BUNDLED_HOST_PACKAGES, hostPackageVersions } from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import { cliError } from '../errors';
import { writeJsonFile, writeTextFile } from '../files';
import { findProject, PackageJson, resolveApiBaseUrl, slugify, WORKFLOWS_DIR } from '../project';

const name = Argument.String('name').pipe(Argument.withDescription('Workflow name; the folder is its slug'));
const agent = Flag.String('agent').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Agent the workflow calls as context.agents.<name>; repeatable'),
);
const toolFlag = Flag.String('tool').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Integration tool the workflow calls as context.tools.<name>; repeatable'),
);
const description = Flag.String('description').pipe(Flag.optional, Flag.withDescription('Manifest description'));

const isIdentifier = (value: string): boolean => /^[A-Za-z_$][\w$]*$/.test(value);
const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (value: string): string => (isIdentifier(value) ? value : quote(value));
const member = (value: string): string => (isIdentifier(value) ? `.${value}` : `[${quote(value)}]`);

const agentNode = (
  agentName: string,
  source: string,
): string => `  .addNode(${JSON.stringify(agentName)}, async (state, config) => {
    const agent = config.context?.agents${member(agentName)};
    if (!agent) throw new Error("No '${agentName}' agent in context. Pass one when invoking locally.");
    const result = await agent.invoke({ messages: [{ role: 'user', content: ${source} }] });
    return { result: lastText(result.messages) };
  })`;

const chainEdges = (nodes: ReadonlyArray<string>): string =>
  ['START', ...nodes, 'END']
    .map((node) => (node === 'START' || node === 'END' ? node : quote(node)))
    .slice(0, -1)
    .map((node, index, all) => `  .addEdge(${node}, ${index + 1 < all.length ? all[index + 1] : 'END'})`)
    .join('\n');

const contextSchemaSource = (agents: ReadonlyArray<string>, tools: ReadonlyArray<string>): string => {
  const members: Array<string> = [];
  if (agents.length > 0)
    members.push(`  agents: z.object({
${agents.map((agentName) => `    ${key(agentName)}: z.custom<Agent>(),`).join('\n')}
  }),`);
  if (tools.length > 0)
    members.push(`  tools: z.object({
${tools.map((toolName) => `    ${key(toolName)}: z.custom<StructuredToolInterface>(),`).join('\n')}
  }),`);
  return `const ContextSchema = z.object({
${members.join('\n')}
});`;
};

const graphSource = (agents: ReadonlyArray<string>, tools: ReadonlyArray<string>): string => {
  const shared = `import { END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

const InputSchema = z.object({
  text: z.string().describe('The request to handle'),
});

const OutputSchema = z.object({
  result: z.string(),
});

const StateSchema = InputSchema.extend(OutputSchema.shape);
`;

  if (agents.length === 0 && tools.length === 0) {
    return `${shared}
const graph = new StateGraph({ input: InputSchema, output: OutputSchema, state: StateSchema })
  .addNode('respond', (state) => ({ result: \`Received: \${state.text}\` }))
${chainEdges(['respond'])}
  .compile();

export default graph;
`;
  }

  const nodes =
    agents.length === 0
      ? [`  .addNode('respond', (state) => ({ result: \`Received: \${state.text}\` }))`]
      : agents.map((agentName, index) => agentNode(agentName, index === 0 ? 'state.text' : 'state.result'));
  const imports = [
    ...(agents.length > 0
      ? [
          "import type { BaseMessage, BaseMessageLike } from '@langchain/core/messages';",
          "import type { Runnable } from '@langchain/core/runnables';",
        ]
      : []),
    ...(tools.length > 0 ? ["import type { StructuredToolInterface } from '@langchain/core/tools';"] : []),
  ];
  const agentType =
    agents.length > 0
      ? `
type Agent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse?: unknown }>;
`
      : '';
  const lastTextHelper =
    agents.length > 0
      ? `
const lastText = (messages: ReadonlyArray<BaseMessage>): string => {
  const last = messages.at(-1);
  return last === undefined ? '' : typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
};
`
      : '';
  return `${imports.join('\n')}
${shared}
/**
 * What the host injects as LangGraph runtime \`context\`. Declared here, not
 * imported: the artifact has no dependency on agentdock. The names match
 * \`agents\` and \`tools\` in ${WORKFLOW_MANIFEST_FILENAME}. Tools are LangChain
 * tools: call \`tool.invoke(args)\` directly or hand them to a model.
 */${agentType}
${contextSchemaSource(agents, tools)}
${lastTextHelper}
const graph = new StateGraph({ input: InputSchema, output: OutputSchema, state: StateSchema, context: ContextSchema })
${nodes.join('\n')}
${chainEdges(agents.length === 0 ? ['respond'] : agents)}
  .compile();

export default graph;
`;
};

const readmeSource = (
  slug: string,
  displayName: string,
  agents: ReadonlyArray<string>,
  tools: ReadonlyArray<string>,
): string => {
  const bindings =
    agents.length === 0
      ? ''
      : ` --agent ${agents.map((a) => `${a}=agents/${slugify(a)}.agent.yaml`).join(' --agent ')}`;
  return `# ${displayName}

A workflow artifact: plain LangGraph code plus \`${WORKFLOW_MANIFEST_FILENAME}\`. The
code imports nothing from agentdock; agents${agents.length ? ` (${agents.join(', ')})` : ''}, tools${
    tools.length ? ` (${tools.join(', ')})` : ''
  }, secrets and the
checkpointer arrive through LangGraph's runtime \`context\` and \`configurable\`.

\`\`\`sh
bun install --omit=peer                       # pins dependencies in bun.lock; peers resolve from the project
agentdock check ${WORKFLOWS_DIR}/${slug}                # manifest, graph export, topology, contracts
agentdock run ${WORKFLOWS_DIR}/${slug} '{"text":"hello"}'${bindings}
agentdock push ${slug}                        # registers it; names in agents and tools are bound on the server
\`\`\`

Input and output contracts derive from the Zod schemas in \`workflow.ts\`. See
\`docs/workflows.md\` in the agentdock repository for the full contract.
`;
};

const create = (
  rawName: string,
  agents: ReadonlyArray<string>,
  tools: ReadonlyArray<string>,
  descriptionValue: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const slug = slugify(rawName);
    if (slug.length === 0) return yield* cliError(`'${rawName}' does not yield a usable folder name.`);
    const project = yield* findProject;
    const folder = Option.match(project, {
      onNone: () => path.resolve(slug),
      onSome: (found) => path.join(found.root, WORKFLOWS_DIR, slug),
    });
    if (yield* fs.exists(folder)) return yield* cliError(`${folder} already exists.`);
    const api = yield* resolveApiBaseUrl;

    const manifest = {
      $schema: `${api}/schemas/workflow-manifest.json`,
      name: rawName,
      description: Option.getOrElse(descriptionValue, () => `Describe what ${rawName} does.`),
      version: '0.1.0',
      graph: './workflow.ts:default',
      agents:
        agents.length === 0
          ? undefined
          : Object.fromEntries(agents.map((a) => [a, { description: `Describe what ${a} is asked to do.` }])),
      tools:
        tools.length === 0
          ? undefined
          : Object.fromEntries(tools.map((t) => [t, { description: `Describe what ${t} is called for.` }])),
    } satisfies WorkflowManifest;
    yield* writeJsonFile(WorkflowManifest, path.join(folder, WORKFLOW_MANIFEST_FILENAME), manifest);
    yield* writeJsonFile(PackageJson, path.join(folder, 'package.json'), {
      name: slug,
      private: true,
      type: 'module',
      dependencies: { zod: '^4' },
      peerDependencies: hostPackageVersions(),
      // Not on the npm registry: optional, so `bun install` records the range without fetching it.
      peerDependenciesMeta: Object.fromEntries(BUNDLED_HOST_PACKAGES.map((bundled) => [bundled, { optional: true }])),
    });
    yield* writeTextFile(path.join(folder, 'workflow.ts'), graphSource(agents, tools));
    yield* writeTextFile(path.join(folder, 'README.md'), readmeSource(slug, rawName, agents, tools));
    yield* writeTextFile(path.join(folder, '.gitignore'), 'node_modules/\n');

    const shown = path.relative(process.cwd(), folder) || '.';
    yield* Console.log(`Created workflow '${rawName}' in ${shown}/`);
    yield* Console.log('');
    yield* Console.log('Next:');
    yield* Console.log(`  (cd ${shown} && bun install --omit=peer)`);
    yield* Console.log(`  agentdock check ${shown}`);
    yield* Console.log(`  agentdock run ${shown} '{"text":"hello"}'`);
    for (const agentName of agents) {
      yield* Console.log(
        `  # bind '${agentName}': create agents/${slugify(agentName)}.agent.yaml or pass --agent ${agentName}=<file|url>`,
      );
    }
    for (const toolName of tools) {
      yield* Console.log(
        `  # '${toolName}' binds to the catalog tool of that name on the server; pass --tool ${toolName}=<tool id> if several share it`,
      );
    }
  }).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(cliError(error.message))));

export const newCommand = Command.make(
  'new',
  { name, agent, tool: toolFlag, description },
  ({ name, agent, tool, description }) => create(name, agent, tool, description),
).pipe(Command.withDescription('Scaffold a workflow artifact folder'));
