import { CreateSkillInput, Skill } from 'agentdock-sdk/schemas';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

/** A skill document that does not satisfy the Agent Skills spec. */
export class SkillParseError extends Schema.TaggedError<SkillParseError>()('SkillParseError', {
  message: Schema.String,
}) {}

type SkillParserService = {
  readonly parse: (input: CreateSkillInput) => Effect.Effect<Skill, SkillParseError>;
};

const decodeCreateSkillInput = Schema.decodeUnknownSync(CreateSkillInput);
const decodeSkill = Schema.decodeUnknownSync(Skill);
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The instructions of a SKILL.md document, without its frontmatter. */
export const skillBody = (content: string): string =>
  content
    .replace(/^\uFEFF/, '')
    .replace(frontmatterPattern, '')
    .trim();

const parseFrontmatter = (content: string) => {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(frontmatterPattern);
  if (!match) throw new Error('Skill content must start with YAML frontmatter.');

  const metadata = new Map<string, string>();
  const frontmatter = match[1] ?? '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (field?.[1] && field[2] !== undefined) metadata.set(field[1], field[2].replace(/^['"]|['"]$/g, '').trim());
  }

  const name = metadata.get('name');
  const description = metadata.get('description');
  if (!name || !skillNamePattern.test(name) || name.length > 64)
    throw new Error('Skill name must match the Agent Skills spec.');
  if (!description || description.length > 1024) throw new Error('Skill description must match the Agent Skills spec.');

  const compatibility = metadata.get('compatibility');
  if (compatibility && compatibility.length > 500)
    throw new Error('Skill compatibility must be 500 characters or fewer.');

  return {
    name,
    description,
    license: metadata.get('license'),
    compatibility,
    allowedTools: metadata.get('allowed-tools'),
  };
};

export const SkillParser = Context.Service<SkillParserService>('@agentdock/api/SkillParser');

export const SkillParserLive = Layer.succeed(
  SkillParser,
  SkillParser.of({
    parse: Effect.fn('SkillParser.parse')(function* (input) {
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.try({
        try: () => {
          const validated = decodeCreateSkillInput(input);
          const parsed = parseFrontmatter(validated.content);
          return decodeSkill({
            id: parsed.name,
            name: parsed.name,
            description: parsed.description,
            content: validated.content,
            createdAt: now,
            updatedAt: now,
            license: parsed.license,
            compatibility: parsed.compatibility,
            allowedTools: parsed.allowedTools,
            source: validated.source,
            builtin: false,
          });
        },
        catch: (error) => new SkillParseError({ message: error instanceof Error ? error.message : String(error) }),
      });
    }),
  }),
);
