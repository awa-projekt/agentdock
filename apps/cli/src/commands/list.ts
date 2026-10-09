import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { listAgents, listWorkflows } from '../remote';

export const agentsCommand = Command.make('agents', {}, () =>
  Effect.gen(function* () {
    const agents = yield* listAgents;
    if (agents.length === 0) return yield* Console.log('No agents.');
    for (const agent of agents) {
      yield* Console.log(`${agent.id}  ${agent.name}  @${agent.revision}`);
    }
  }),
).pipe(Command.withDescription('List agents on the server'));

export const workflowsCommand = Command.make('workflows', {}, () =>
  Effect.gen(function* () {
    const workflows = yield* listWorkflows;
    if (workflows.length === 0) return yield* Console.log('No workflows.');
    for (const workflow of workflows) {
      yield* Console.log(
        `${workflow.id}  ${workflow.manifest.name}  v${workflow.manifest.version}  @${workflow.revision}  ${workflow.sourceHash}`,
      );
    }
  }),
).pipe(Command.withDescription('List workflows on the server'));
