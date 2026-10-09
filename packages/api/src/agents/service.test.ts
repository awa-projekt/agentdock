import { describe, expect, it } from '@effect/vitest';
import type { AddExternalA2aAgentInput, CreateAgentInput } from 'agentdock-sdk/schemas';
import { AGENT_COLOR_PALETTE, AgentColor, HOME_INTERNAL_AGENT_ID } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { AgentRegistry, AgentRegistryLive } from './service';

const createInput = (overrides: Partial<CreateAgentInput> = {}): CreateAgentInput => ({
  name: 'Test Agent',
  description: 'An agent for tests',
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: 'Be useful',
  model: 'openai:gpt-5.6-luna',
  version: '0.1.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  ...overrides,
});

// endpoint_url is UNIQUE, so give each created external agent a distinct URL.
let externalEndpointCounter = 0;
const externalInput = (overrides: Partial<AddExternalA2aAgentInput> = {}): AddExternalA2aAgentInput => ({
  name: 'External Agent',
  description: 'A remote A2A agent',
  endpointUrl: `https://remote.example.com/a2a/${externalEndpointCounter++}`,
  version: '1.0.0',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  ...overrides,
});

describe('AgentRegistry (public agents)', () => {
  it.effect('adds an agent, assigns a generated id and public visibility, and lists it', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.add(createInput({ name: 'Roundtrip Agent' }));
      const listed = yield* registry.list();

      expect(added.id).toMatch(/^[0-9a-f]{8}$/);
      expect(added.visibility).toBe('public');
      expect(added.name).toBe('Roundtrip Agent');
      expect(AGENT_COLOR_PALETTE).toContain(added.color);
      expect(listed.map((agent) => agent.id)).toContain(added.id);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('updates an existing agent and returns the new values', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.add(createInput());
      const updated = yield* registry.update(added.id, createInput({ name: 'Renamed', instructions: 'Changed' }));

      expect(updated?.name).toBe('Renamed');
      expect(updated?.instructions).toBe('Changed');
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('persists an explicitly selected color', () =>
    Effect.gen(function* () {
      const color = AgentColor.make('#123abc');
      const registry = yield* AgentRegistry;
      const added = yield* registry.add(createInput({ color }));
      const updated = yield* registry.update(added.id, createInput({ color }));

      expect(added.color).toBe(color);
      expect(updated?.color).toBe(color);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('removes an existing agent and reports it gone', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.add(createInput());
      const removed = yield* registry.remove(added.id);
      const found = yield* registry.getById(added.id);

      expect(removed).toBe(true);
      expect(found).toBeNull();
    }).pipe(Effect.provide(AgentRegistryLive)),
  );
});

describe('AgentRegistry (internal agents are protected)', () => {
  it.effect('exposes the built-in internal agent through listInternal and getById', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const internal = yield* registry.listInternal();
      const byId = yield* registry.getById(HOME_INTERNAL_AGENT_ID);

      expect(internal.some((agent) => agent.id === HOME_INTERNAL_AGENT_ID)).toBe(true);
      expect(byId?.id).toBe(HOME_INTERNAL_AGENT_ID);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('refuses to update or remove an internal agent', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const updated = yield* registry.update(HOME_INTERNAL_AGENT_ID, createInput({ name: 'Hijacked' }));
      const removed = yield* registry.remove(HOME_INTERNAL_AGENT_ID);

      expect(updated).toBeNull();
      expect(removed).toBe(false);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('keeps internal agents out of the public list', () =>
    Effect.gen(function* () {
      const list = yield* AgentRegistry.use((registry) => registry.list());
      expect(list.some((agent) => agent.id === HOME_INTERNAL_AGENT_ID)).toBe(false);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );
});

describe('AgentRegistry (external A2A agents)', () => {
  it.effect('adds and lists an external agent', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.addExternal(externalInput());
      const listed = yield* registry.listExternal();

      expect(added.visibility).toBe('external');
      expect(added.endpointUrl).toMatch(/^https:\/\/remote\.example\.com\/a2a\//);
      expect(listed.map((agent) => agent.id)).toContain(added.id);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('updates an existing external agent and returns null for a missing one', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.addExternal(externalInput());
      const updated = yield* registry.updateExternal(added.id, externalInput({ name: 'Renamed Remote' }));
      const missing = yield* registry.updateExternal('missing-id', externalInput());

      expect(updated?.name).toBe('Renamed Remote');
      expect(missing).toBeNull();
    }).pipe(Effect.provide(AgentRegistryLive)),
  );

  it.effect('removes an external agent', () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const added = yield* registry.addExternal(externalInput());
      const removed = yield* registry.removeExternal(added.id);
      const removedAgain = yield* registry.removeExternal(added.id);

      expect(removed).toBe(true);
      expect(removedAgain).toBe(false);
    }).pipe(Effect.provide(AgentRegistryLive)),
  );
});
