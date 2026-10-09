import { describe, expect, it } from '@effect/vitest';
import type { CreateSkillInput } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { SkillParser, SkillParserLive } from './parser';

const parse = (input: CreateSkillInput) => SkillParser.use((parser) => parser.parse(input));

const parseError = (input: CreateSkillInput) => Effect.flip(parse(input));

const frontmatter = (fields: Record<string, string>, body = 'Body text'): string => {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

describe('SkillParser', () => {
  it.effect('extracts name and description from frontmatter', () =>
    Effect.gen(function* () {
      const skill = yield* parse({ content: frontmatter({ name: 'pdf-tools', description: 'Work with PDFs' }) });
      expect(skill.id).toBe('pdf-tools');
      expect(skill.name).toBe('pdf-tools');
      expect(skill.description).toBe('Work with PDFs');
      expect(skill.content).toContain('Body text');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('parses optional metadata and strips surrounding quotes', () =>
    Effect.gen(function* () {
      const skill = yield* parse({
        content: frontmatter({
          name: 'pdf-tools',
          description: '"Quoted description"',
          license: 'MIT',
          compatibility: 'claude-code',
          'allowed-tools': 'Read, Write',
        }),
      });
      expect(skill.description).toBe('Quoted description');
      expect(skill.license).toBe('MIT');
      expect(skill.compatibility).toBe('claude-code');
      expect(skill.allowedTools).toBe('Read, Write');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('omits optional fields that are not present in the frontmatter', () =>
    Effect.gen(function* () {
      const skill = yield* parse({ content: frontmatter({ name: 'pdf-tools', description: 'Work with PDFs' }) });
      expect(skill.license).toBeUndefined();
      expect(skill.compatibility).toBeUndefined();
      expect(skill.allowedTools).toBeUndefined();
      expect(skill.source).toBeUndefined();
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('tolerates a leading BOM and CRLF line endings', () =>
    Effect.gen(function* () {
      const content = '﻿---\r\nname: pdf-tools\r\ndescription: Work with PDFs\r\n---\r\nBody';
      const skill = yield* parse({ content });
      expect(skill.name).toBe('pdf-tools');
      expect(skill.description).toBe('Work with PDFs');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('rejects content without frontmatter', () =>
    Effect.gen(function* () {
      const error = yield* parseError({ content: 'No frontmatter here' });
      expect(error.message).toContain('YAML frontmatter');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('rejects names that do not match the Agent Skills spec', () =>
    Effect.gen(function* () {
      const badCase = yield* parseError({ content: frontmatter({ name: 'PDF Tools', description: 'x' }) });
      expect(badCase.message).toContain('Skill name must match');
      const leadingDash = yield* parseError({ content: frontmatter({ name: '-leading-dash', description: 'x' }) });
      expect(leadingDash.message).toContain('Skill name must match');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('rejects a missing description', () =>
    Effect.gen(function* () {
      const error = yield* parseError({ content: frontmatter({ name: 'pdf-tools' }) });
      expect(error.message).toContain('Skill description must match');
    }).pipe(Effect.provide(SkillParserLive)),
  );

  it.effect('rejects an over-long compatibility field', () =>
    Effect.gen(function* () {
      const error = yield* parseError({
        content: frontmatter({ name: 'pdf-tools', description: 'ok', compatibility: 'x'.repeat(501) }),
      });
      expect(error.message).toContain('compatibility must be 500 characters');
    }).pipe(Effect.provide(SkillParserLive)),
  );
});
