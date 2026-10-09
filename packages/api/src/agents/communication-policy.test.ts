import { describe, expect, it } from '@effect/vitest';
import type { CreateAgentInput } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { AgentCommunicationPolicy, AgentCommunicationPolicyLive } from './communication-policy';
import { AgentRegistry, AgentRegistryLive } from './service';

const testLayer = Layer.mergeAll(AgentCommunicationPolicyLive, AgentRegistryLive);

const createInput = (name: string): CreateAgentInput => ({
  name,
  description: `agent ${name}`,
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: '',
  model: 'openai:gpt-5.6-luna',
  version: '0.1.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
});

describe('AgentCommunicationPolicy.isAllowed', () => {
  it.effect('denies an agent talking to itself', () =>
    Effect.gen(function* () {
      const allowed = yield* AgentCommunicationPolicy.use((policy) =>
        policy.isAllowed({ sourceAgentId: 'a', targetAgentId: 'a' }),
      );
      expect(allowed).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('allows once an explicit rule is added, but not for other targets', () =>
    Effect.gen(function* () {
      const policy = yield* AgentCommunicationPolicy;
      yield* policy.allow({ sourceAgentId: 'a', targetAgentId: 'b' });

      expect(yield* policy.isAllowed({ sourceAgentId: 'a', targetAgentId: 'b' })).toBe(true);
      expect(yield* policy.isAllowed({ sourceAgentId: 'a', targetAgentId: 'c' })).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('treats a wildcard rule as access to any target', () =>
    Effect.gen(function* () {
      const policy = yield* AgentCommunicationPolicy;
      yield* policy.replaceForAgent({ sourceAgentId: 'wild', targetAgentIds: ['*'] });

      expect(yield* policy.isAllowed({ sourceAgentId: 'wild', targetAgentId: 'whoever' })).toBe(true);
      expect(yield* policy.isAllowed({ sourceAgentId: 'other', targetAgentId: 'whoever' })).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('AgentCommunicationPolicy.replaceForAgent', () => {
  it.effect('replaces the full set of allowed targets for the source', () =>
    Effect.gen(function* () {
      const policy = yield* AgentCommunicationPolicy;
      yield* policy.replaceForAgent({ sourceAgentId: 'src', targetAgentIds: ['x', 'y'] });
      const afterFirst = {
        x: yield* policy.isAllowed({ sourceAgentId: 'src', targetAgentId: 'x' }),
        y: yield* policy.isAllowed({ sourceAgentId: 'src', targetAgentId: 'y' }),
      };

      yield* policy.replaceForAgent({ sourceAgentId: 'src', targetAgentIds: ['z'] });
      const afterReplace = {
        x: yield* policy.isAllowed({ sourceAgentId: 'src', targetAgentId: 'x' }),
        z: yield* policy.isAllowed({ sourceAgentId: 'src', targetAgentId: 'z' }),
      };

      expect(afterFirst).toEqual({ x: true, y: true });
      expect(afterReplace).toEqual({ x: false, z: true });
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('AgentCommunicationPolicy.listAllowedTargets', () => {
  it.effect('resolves allowed rules to real agents and excludes the source itself', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const policy = yield* AgentCommunicationPolicy;
      const source = yield* registry.add(createInput('Source'));
      const allowed = yield* registry.add(createInput('Allowed'));
      yield* registry.add(createInput('Unrelated'));

      yield* policy.replaceForAgent({ sourceAgentId: source.id, targetAgentIds: [allowed.id] });
      const targets = yield* policy.listAllowedTargets(source.id);

      expect(targets.map((agent) => agent.id)).toEqual([allowed.id]);
      expect(targets.some((agent) => agent.id === source.id)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('returns every other agent under a wildcard rule', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const policy = yield* AgentCommunicationPolicy;
      const source = yield* registry.add(createInput('WildSource'));
      const a = yield* registry.add(createInput('A'));
      const b = yield* registry.add(createInput('B'));

      yield* policy.replaceForAgent({ sourceAgentId: source.id, targetAgentIds: ['*'] });
      const targetIds = (yield* policy.listAllowedTargets(source.id)).map((agent) => agent.id);

      expect(targetIds).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(targetIds).not.toContain(source.id);
    }).pipe(Effect.provide(testLayer)),
  );
});
