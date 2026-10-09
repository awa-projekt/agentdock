import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Path from 'effect/Path';
import { writeBytes } from '../files';
import {
  agentConfigOf,
  readState,
  requireProject,
  selects,
  slugify,
  workflowFolderPath,
  writeLocalAgent,
  writeState,
} from '../project';
import { downloadWorkflowArtifact, listAgents, listWorkflows } from '../remote';

const names = Argument.String('names').pipe(
  Argument.variadic(),
  Argument.withDescription('Agent or workflow names to pull; pulls everything when omitted'),
);

const pull = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const project = yield* requireProject;
    const path = yield* Path.Path;
    const state = yield* readState(project);
    const agents = { ...state.agents };
    const workflows = { ...state.workflows };

    for (const agent of yield* listAgents) {
      if (!selects(names, slugify(agent.name), agent.name)) continue;
      const slug = yield* writeLocalAgent(project, agentConfigOf(agent));
      agents[slug] = { id: agent.id, revision: agent.revision };
      yield* Console.log(`agent     ${slug}  (${agent.id} @${agent.revision})`);
    }

    for (const workflow of yield* listWorkflows) {
      const slug = slugify(workflow.manifest.name);
      if (!selects(names, slug, workflow.manifest.name)) continue;
      const download = yield* downloadWorkflowArtifact(workflow.id);
      const folder = yield* workflowFolderPath(project, slug);
      for (const file of download.files) {
        yield* writeBytes(path.join(folder, file.path), Buffer.from(file.content, 'base64'));
      }
      workflows[slug] = { id: workflow.id, revision: download.workflow.revision };
      yield* Console.log(
        `workflow  ${slug}  (${workflow.id} @${download.workflow.revision}, ${download.files.length} files)`,
      );
    }

    yield* writeState(project, { agents, workflows });
  });

export const pullCommand = Command.make('pull', { names }, ({ names }) => pull(names)).pipe(
  Command.withDescription('Download agents and workflows from the server into the project'),
);
