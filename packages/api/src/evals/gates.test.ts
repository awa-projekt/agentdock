import { describe, expect, it } from '@effect/vitest';
import { type CreateAgentInput, type EvalRun, EvalValidationError } from 'agentdock-sdk/schemas';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';
import { AgentRegistry, AgentRegistryLive } from '../agents/service';
import { EvalGates, makeEvalGatesLayer } from './gates';
import { EvalService, EvalServiceLive } from './service';
import { EvalTargets } from './targets';
import {
  awaitRun,
  exactMatch,
  fakeJudge,
  fakeProviderKeys,
  fakeTargets,
  storeLayer,
  type TargetCall,
} from './test-layers';

const agentInput: CreateAgentInput = {
  name: 'Capitals bot',
  description: 'Names capitals',
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: 'Name the capital.',
  model: 'openai:echo',
  version: '0.1.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

/** The fake target's answers, resolved against the live registry so a gated run sees the agent's current model. */
const registryTargets = (calls: Array<TargetCall>) =>
  Layer.effect(
    EvalTargets,
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const fake = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* EvalTargets;
        }),
        fakeTargets(calls),
      );
      return EvalTargets.of({
        resolve: (target) =>
          registry.getById(target.id).pipe(
            Effect.orDie,
            Effect.flatMap((agent) =>
              agent
                ? Effect.succeed({
                    kind: 'agent' as const,
                    id: agent.id,
                    name: agent.name,
                    model: agent.model,
                    revision: agent.revision,
                  })
                : Effect.fail(new EvalValidationError({ message: `The agent '${target.id}' does not exist.` })),
            ),
          ),
        run: fake.run,
      });
    }),
  );

/** The real agent registry, so an agent update reaches the gates through the change feed as it does in the app. */
const gatesLayer = (calls: Array<TargetCall>) =>
  makeEvalGatesLayer({ debounce: Duration.millis(40) }).pipe(
    Layer.provideMerge(EvalServiceLive),
    Layer.provide(Layer.mergeAll(registryTargets(calls), fakeJudge(), fakeProviderKeys)),
    Layer.provideMerge(Layer.mergeAll(storeLayer, AgentRegistryLive)),
  );

/** Waits until `count` runs exist and none is still running. */
const awaitRuns = (count: number) =>
  EvalService.use((evals) => evals.listRuns()).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(20)),
      until: (runs: ReadonlyArray<EvalRun>) => runs.length >= count && runs.every((run) => run.status !== 'running'),
    }),
    Effect.timeout(Duration.seconds(5)),
  );

const setup = Effect.gen(function* () {
  const evals = yield* EvalService;
  const agent = yield* AgentRegistry.use((registry) => registry.add(agentInput));
  const grader = yield* evals.createGrader(exactMatch);
  const dataset = yield* evals.createDataset({
    name: 'Capitals',
    description: '',
    graderIds: [grader.id],
    cases: [
      { input: 'paris', expected: 'PARIS', tags: ['regression'] },
      { input: 'rome', expected: 'ROME', tags: ['regression'] },
      { input: 'lima', expected: 'LIMA', tags: ['capability'] },
    ],
  });
  const gate = yield* EvalGates.use((gates) =>
    gates.create({
      datasetId: dataset.id,
      agentId: agent.id,
      graderIds: [grader.id],
      tags: ['regression'],
      trials: 1,
      concurrency: 2,
      enabled: true,
    }),
  );
  return { agent, gate };
});

describe('EvalGates', () => {
  it.live('reruns its suite when the agent changes and compares it with the previous run', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const { agent, gate } = yield* setup;
      expect(gate).toMatchObject({ agentName: 'Capitals bot', datasetName: 'Capitals', enabled: true });
      // Creating a gate records the agent as it is; nothing runs until it changes.
      yield* Effect.sleep(Duration.millis(150));
      expect(calls).toHaveLength(0);

      const baseline = yield* EvalGates.use((gates) => gates.run(gate.id));
      expect(baseline.trigger).toEqual({ kind: 'gate', gateId: gate.id, changed: [] });
      yield* awaitRun(baseline.id);
      expect(calls.map((call) => call.input)).toEqual(['paris', 'rome']);

      yield* AgentRegistry.use((registry) =>
        registry.update(agent.id, { ...agentInput, instructions: 'Name the capital city, in capitals.' }),
      );
      const runs = yield* awaitRuns(2);
      const [latest] = runs;
      expect(latest?.trigger).toEqual({ kind: 'gate', gateId: gate.id, changed: ['instructions'] });
      expect(latest?.baseline).toMatchObject({ runId: baseline.id, verdict: 'unchanged', pairedCases: 2 });
      expect(calls).toHaveLength(4);

      const listed = yield* EvalGates.use((gates) => gates.list());
      expect(listed[0]?.lastRunId).toBe(latest?.id);
    }).pipe(Effect.provide(gatesLayer(calls)));
  });

  it.live('settles a burst of edits into one run and ignores settings it does not watch', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const { agent } = yield* setup;
      const registry = yield* AgentRegistry;
      yield* registry.update(agent.id, { ...agentInput, description: 'Only the description changed' });
      yield* Effect.sleep(Duration.millis(150));
      expect(calls).toHaveLength(0);

      yield* registry.update(agent.id, { ...agentInput, model: 'openai:echo-2' });
      yield* registry.update(agent.id, { ...agentInput, model: 'openai:echo-2', reasoningEffort: 'high' });
      const runs = yield* awaitRuns(1);
      yield* Effect.sleep(Duration.millis(150));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trigger).toEqual({
        kind: 'gate',
        gateId: expect.any(String),
        changed: ['model', 'reasoningEffort'],
      });
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(gatesLayer(calls)));
  });

  it.live('stays quiet while disabled and records why a run could not start', () => {
    const calls: Array<TargetCall> = [];
    return Effect.gen(function* () {
      const { agent, gate } = yield* setup;
      const gates = yield* EvalGates;
      const input = {
        datasetId: gate.datasetId,
        agentId: gate.agentId,
        graderIds: gate.graderIds,
        tags: gate.tags,
        trials: gate.trials,
        concurrency: gate.concurrency,
      };
      yield* gates.update(gate.id, { ...input, enabled: false });
      const registry = yield* AgentRegistry;
      yield* registry.update(agent.id, { ...agentInput, instructions: 'Changed while disabled.' });
      yield* Effect.sleep(Duration.millis(150));
      expect(calls).toHaveLength(0);

      // The agent moves to a provider with no key: the gate cannot run and says why.
      yield* registry.update(agent.id, { ...agentInput, instructions: 'Changed again.', model: 'anthropic:claude' });
      const enabled = yield* Effect.flip(gates.update(gate.id, { ...input, enabled: true }));
      expect(enabled.message).toBe("The agent 'Capitals bot' uses anthropic, which has no API key configured.");
      const onDemand = yield* Effect.flip(gates.run(gate.id));
      expect(onDemand.message).toBe("The agent 'Capitals bot' uses anthropic, which has no API key configured.");
      const [listed] = yield* gates.list();
      expect(listed?.lastError).toBe("The agent 'Capitals bot' uses anthropic, which has no API key configured.");
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(gatesLayer(calls)));
  });
});
