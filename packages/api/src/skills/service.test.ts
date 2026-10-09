import { describe, expect, it } from '@effect/vitest';
import { SkillId } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { agentInstructions } from './prompt';
import { SkillRegistry, SkillRegistryLive } from './service';

const skillDocument = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: The ${name} procedure.\n---\n\n${body}\n`;

describe('SkillRegistry built-in skills', () => {
  it.effect('ships the agentdock skill, which cannot be replaced or removed', () =>
    Effect.gen(function* () {
      const registry = yield* SkillRegistry;
      const shipped = yield* registry.get('agentdock');
      const replaced = yield* Effect.flip(registry.add({ content: skillDocument('agentdock', 'Overridden.') }));

      expect(shipped?.builtin).toBe(true);
      expect((yield* registry.list()).map((skill) => skill.id)).toContain('agentdock');
      expect(replaced._tag).toBe('SkillRegistryError');
      expect(yield* registry.remove('agentdock')).toBe(false);
    }).pipe(Effect.provide(SkillRegistryLive)),
  );
});

describe('agentInstructions', () => {
  it.effect('injects inject skills, lists on-demand skills by description and drops deleted ones', () =>
    Effect.gen(function* () {
      const registry = yield* SkillRegistry;
      const injected = yield* registry.add({ content: skillDocument('house-style', 'Write in plain English.') });
      const onDemand = yield* registry.add({ content: skillDocument('release-notes', 'Group changes by area.') });

      const prompt = agentInstructions(
        {
          instructions: 'You write docs.',
          skills: { [injected.id]: 'inject', [onDemand.id]: 'on-demand', [SkillId.make('deleted')]: 'inject' },
        },
        [injected, onDemand],
      );

      expect(prompt.instructions).toContain('<skill name="house-style">\nWrite in plain English.\n</skill>');
      expect(prompt.instructions).not.toContain('name: house-style');
      expect(prompt.instructions).toContain('- release-notes: The release-notes procedure.');
      expect(prompt.instructions).not.toContain('Group changes by area.');
      expect(prompt.skills).toEqual({ 'house-style': 'inject', 'release-notes': 'on-demand' });
    }).pipe(Effect.provide(SkillRegistryLive)),
  );
});
