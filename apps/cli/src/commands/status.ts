import { loadWorkflowManifest } from 'agentdock-sdk/workflows';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Path from 'effect/Path';
import { cliError } from '../errors';
import {
  agentConfigJson,
  agentConfigOf,
  localWorkflowFolders,
  readLocalAgents,
  readState,
  requireProject,
} from '../project';
import { listAgents, listWorkflows } from '../remote';

type ItemStatus = 'new' | 'unchanged' | 'modified' | 'outdated' | 'conflict' | 'missing on server';

const statusOf = (
  tracked: { readonly revision: number } | undefined,
  remoteRevision: number | undefined,
  sameContent: boolean,
): ItemStatus => {
  if (tracked === undefined) return 'new';
  if (remoteRevision === undefined) return 'missing on server';
  const remoteMoved = remoteRevision !== tracked.revision;
  if (sameContent) return remoteMoved ? 'outdated' : 'unchanged';
  return remoteMoved ? 'conflict' : 'modified';
};

const status = Effect.gen(function* () {
  const project = yield* requireProject;
  const path = yield* Path.Path;
  const state = yield* readState(project);
  const remoteAgents = yield* listAgents;
  const remoteWorkflows = yield* listWorkflows;
  const rows: Array<[string, string, ItemStatus]> = [];

  for (const agent of yield* readLocalAgents(project)) {
    const tracked = state.agents[agent.slug];
    const remote = tracked ? remoteAgents.find((candidate) => candidate.id === tracked.id) : undefined;
    const same = remote !== undefined && agentConfigJson(agentConfigOf(remote)) === agentConfigJson(agent.config);
    rows.push(['agent', agent.slug, statusOf(tracked, remote?.revision, same)]);
  }

  for (const workflow of yield* localWorkflowFolders(project)) {
    const loaded = yield* loadWorkflowManifest(workflow.folder).pipe(
      Effect.mapError((error) => cliError(`${path.relative(project.root, workflow.folder)}: ${error.message}`)),
    );
    const tracked = state.workflows[workflow.slug];
    const remote = tracked ? remoteWorkflows.find((candidate) => candidate.id === tracked.id) : undefined;
    rows.push([
      'workflow',
      workflow.slug,
      statusOf(tracked, remote?.revision, remote?.sourceHash === loaded.sourceHash),
    ]);
  }

  if (rows.length === 0) {
    yield* Console.log('No local agents or workflows.');
    return;
  }
  const width = Math.max(...rows.map(([, slug]) => slug.length));
  for (const [kind, slug, item] of rows) {
    yield* Console.log(`${kind.padEnd(8)}  ${slug.padEnd(width)}  ${item}`);
  }
});

export const statusCommand = Command.make('status', {}, () => status).pipe(
  Command.withDescription('Compare local agents and workflows with the server'),
);
