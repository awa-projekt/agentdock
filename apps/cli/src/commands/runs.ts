import type { WorkflowRun } from 'agentdock-sdk/schemas';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { clip, describeEvent, jsonFlag, verboseFlag, writeJson } from '../output';
import { findRemoteWorkflow, getWorkflowRun, listWorkflowRunEvents, listWorkflowRuns, listWorkflows } from '../remote';

const runId = Argument.String('run-id').pipe(Argument.optional, Argument.withDescription('Show one run in detail'));
const workflow = Flag.String('workflow').pipe(
  Flag.optional,
  Flag.withDescription('Only runs of this workflow (id, folder slug or manifest name)'),
);
const limit = Flag.Int('limit').pipe(Flag.withDefault(20), Flag.withDescription('Most recent runs to list'));

const byStartedDesc = (left: WorkflowRun, right: WorkflowRun): number => right.startedAt.localeCompare(left.startedAt);

const list = (workflowRef: Option.Option<string>, limit: number, json: boolean) =>
  Effect.gen(function* () {
    const selected = yield* Option.match(workflowRef, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (ref) => Effect.map(findRemoteWorkflow(ref), (found) => Option.some<string>(found.id)),
    });
    const names = new Map((yield* listWorkflows).map((item) => [item.id, item.manifest.name] as const));
    const runs = (yield* listWorkflowRuns)
      .filter((run) => Option.match(selected, { onNone: () => true, onSome: (id) => run.workflowId === id }))
      .sort(byStartedDesc)
      .slice(0, limit);

    if (json) return writeJson(runs.map((run) => ({ ...run, workflowName: names.get(run.workflowId) ?? null })));
    if (runs.length === 0) return yield* Console.log('No runs.');
    for (const run of runs) {
      const name = names.get(run.workflowId) ?? run.workflowId;
      yield* Console.log(`${run.id}  ${run.startedAt}  ${run.status.padEnd(14)}  ${name}  ${clip(run.input, 60)}`);
    }
  });

const show = (id: string, json: boolean, verbose: boolean) =>
  Effect.gen(function* () {
    const snapshot = yield* getWorkflowRun(id);
    const events = yield* listWorkflowRunEvents(id);
    if (json) return writeJson({ ...snapshot, events });

    const { run, steps } = snapshot;
    yield* Console.log(`run ${run.id}  ${run.status}`);
    yield* Console.log(`  workflow:   ${run.workflowId}`);
    yield* Console.log(`  task:       ${run.taskId}`);
    yield* Console.log(`  started:    ${run.startedAt}`);
    if (run.completedAt) yield* Console.log(`  completed:  ${run.completedAt}`);
    yield* Console.log(`  input:      ${verbose ? run.input : clip(run.input)}`);
    if (run.output) yield* Console.log(`  output:     ${verbose ? run.output : clip(run.output)}`);
    if (run.error) yield* Console.log(`  error:      ${run.error}`);

    if (steps.length > 0) {
      yield* Console.log('\nsteps:');
      const width = Math.max(...steps.map((step) => step.stepId.length));
      for (const step of steps) {
        const suffix = step.error ? `  ${step.error}` : verbose && step.output ? `  ${clip(step.output, 400)}` : '';
        const runs = step.executions > 1 ? ` ×${step.executions}` : '';
        yield* Console.log(`  ${step.stepId.padEnd(width)}  ${step.status}${runs}${suffix}`);
      }
    }

    if (events.length > 0) {
      yield* Console.log('\nevents:');
      for (const event of events) yield* Console.log(`  ${event.timestamp}  ${describeEvent(event, verbose)}`);
    }
  });

export const runsCommand = Command.make(
  'runs',
  { runId, workflow, limit, json: jsonFlag, verbose: verboseFlag },
  ({ runId, workflow, limit, json, verbose }) =>
    Option.match(runId, { onNone: () => list(workflow, limit, json), onSome: (id) => show(id, json, verbose) }),
).pipe(Command.withDescription('List workflow runs on the server, or show one run with its steps and events'));
