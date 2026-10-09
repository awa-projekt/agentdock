import type { RegisterWorkflowInput } from 'agentdock-sdk/schemas';
import { artifactSourceFiles, loadWorkflowManifest } from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Base64 from 'effect/encoding/Base64';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { parseAssignments } from '../bindings';
import { cliError, messageOf } from '../errors';
import {
  agentConfigOf,
  type LocalAgent,
  localWorkflowFolders,
  readLocalAgents,
  readState,
  requireProject,
  type StateFile,
  selects,
  writeState,
} from '../project';
import { createAgent, listAgentTools, registerWorkflow, startOrgOAuth, updateAgent } from '../remote';

const names = Argument.String('names').pipe(
  Argument.variadic(),
  Argument.withDescription('Agent or workflow names to push; pushes everything when omitted'),
);
const force = Flag.Boolean('force').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Overwrite the server revision without checking it'),
);
const bind = Flag.String('bind').pipe(
  Flag.atLeast(0),
  Flag.withDescription('Bind a workflow manifest name to a server id, as name=id'),
);

const readArtifactFiles = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = yield* Effect.tryPromise(() => artifactSourceFiles(folder));
    return yield* Effect.forEach(files, (file) =>
      Effect.map(fs.readFile(path.join(folder, file)), (content) => ({
        path: file,
        content: Base64.encode(content),
      })),
    );
  }).pipe(Effect.mapError((error) => cliError(`Cannot read workflow folder '${folder}': ${messageOf(error)}`)));

const pushAgent = (agent: LocalAgent, tracked: StateFile['agents'][string] | undefined, force: boolean) => {
  const input = agentConfigOf(agent.config);
  return tracked === undefined
    ? createAgent(input)
    : updateAgent(tracked.id, force ? input : { ...input, expectedRevision: tracked.revision });
};

/**
 * A pushed config may name things this server cannot serve yet. Say which, and
 * for an OAuth connection start the flow so the developer only has to open a link.
 */
const reportUnresolved = (agentId: string) =>
  Effect.gen(function* () {
    const { unresolved } = yield* listAgentTools(agentId);
    for (const entry of unresolved) {
      yield* Console.log(`          ! ${entry.message}`);
      if (entry.reason !== 'oauth-required' || entry.slug === undefined) continue;
      const session = yield* startOrgOAuth(entry.slug);
      if (session.state.status === 'pending') {
        yield* Console.log(`            open to authorise: ${session.state.authorizationUrl}`);
      } else if (session.state.status === 'needs-client') {
        yield* Console.log(`            ${session.state.guidance}`);
      }
    }
  });

const push = (names: ReadonlyArray<string>, force: boolean, bindValues: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const project = yield* requireProject;
    const path = yield* Path.Path;
    const bindings = yield* parseAssignments(bindValues, 'bind');
    const state = yield* readState(project);
    const agents = { ...state.agents };
    const workflows = { ...state.workflows };
    const save = writeState(project, { agents, workflows });

    yield* Effect.gen(function* () {
      for (const agent of yield* readLocalAgents(project)) {
        if (!selects(names, agent.slug, agent.config.name)) continue;
        const record = yield* pushAgent(agent, agents[agent.slug], force);
        agents[agent.slug] = { id: record.id, revision: record.revision };
        yield* Console.log(`agent     ${agent.slug}  -> ${record.id} @${record.revision}`);
        yield* reportUnresolved(record.id);
      }

      for (const workflow of yield* localWorkflowFolders(project)) {
        const loaded = yield* loadWorkflowManifest(workflow.folder).pipe(
          Effect.mapError((error) => cliError(`${path.relative(project.root, workflow.folder)}: ${error.message}`)),
        );
        if (!selects(names, workflow.slug, loaded.manifest.name)) continue;
        const files = yield* readArtifactFiles(loaded.folder);
        const tracked = workflows[workflow.slug];
        const base: RegisterWorkflowInput = { files, bindings };
        const input = tracked === undefined || force ? base : { ...base, expectedRevision: tracked.revision };
        const registered = yield* registerWorkflow(input);
        workflows[workflow.slug] = { id: registered.id, revision: registered.revision };
        yield* Console.log(
          `workflow  ${workflow.slug}  -> ${registered.id} @${registered.revision} (${loaded.manifest.name} v${loaded.manifest.version})`,
        );
      }
    }).pipe(Effect.onError(() => Effect.ignore(save)));

    yield* save;
  });

export const pushCommand = Command.make('push', { names, force, bind }, ({ names, force, bind }) =>
  push(names, force, bind),
).pipe(Command.withDescription('Upload local agents and workflows to the server'));
