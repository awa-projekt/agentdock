import { eq, inArray } from 'drizzle-orm';
import { agentsTable, db, skillsTable } from 'db';
import { Context, Data, Effect, Layer, Schema } from 'effect';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AssignAgentSkillsInputSchema,
  CreateSkillInputSchema,
  PullSkillsInputSchema,
  SkillListSchema,
  SkillSchema,
  type CreateSkillInput,
  type PullSkillsInput,
  type Skill,
} from 'agentdock-sdk/api';

type SkillRegistryService = {
  readonly list: () => Effect.Effect<ReadonlyArray<Skill>, unknown>;
  readonly add: (input: CreateSkillInput) => Effect.Effect<Skill, unknown>;
  readonly pull: (input: PullSkillsInput) => Effect.Effect<ReadonlyArray<Skill>, unknown>;
  readonly remove: (skillId: string) => Effect.Effect<boolean, unknown>;
  readonly assignToAgent: (agentId: string, skillIds: ReadonlyArray<string>) => Effect.Effect<boolean, unknown>;
  readonly loadForAgent: (agentId: string, skillId: string) => Effect.Effect<Skill | null, unknown>;
};

class SkillRegistryError extends Data.TaggedError('SkillRegistryError')<{ readonly cause: unknown }> {}

const execFileAsync = promisify(execFile);
const decodeCreateSkillInput = Schema.decodeUnknownSync(CreateSkillInputSchema);
const decodePullSkillsInput = Schema.decodeUnknownSync(PullSkillsInputSchema);
const decodeAssignAgentSkillsInput = Schema.decodeUnknownSync(AssignAgentSkillsInputSchema);
const decodeSkill = Schema.decodeUnknownSync(SkillSchema);
const decodeSkillList = Schema.decodeUnknownSync(SkillListSchema);
const toSkillRegistryError = (cause: unknown): SkillRegistryError => new SkillRegistryError({ cause });
const tryPromise = <A>(try_: () => Promise<A>): Effect.Effect<A, SkillRegistryError> =>
  Effect.tryPromise({ try: try_, catch: toSkillRegistryError });

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const parseFrontmatter = (content: string) => {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Skill content must start with YAML frontmatter.');

  const metadata = new Map<string, string>();
  const frontmatter = match[1] ?? '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (field?.[1] && field[2] !== undefined) metadata.set(field[1], field[2].replace(/^['"]|['"]$/g, '').trim());
  }

  const name = metadata.get('name');
  const description = metadata.get('description');
  if (!name || !skillNamePattern.test(name) || name.length > 64) throw new Error('Skill name must match the Agent Skills spec.');
  if (!description || description.length > 1024) throw new Error('Skill description must match the Agent Skills spec.');

  const compatibility = metadata.get('compatibility');
  if (compatibility && compatibility.length > 500) throw new Error('Skill compatibility must be 500 characters or fewer.');

  return {
    name,
    description,
    license: metadata.get('license'),
    compatibility,
    allowedTools: metadata.get('allowed-tools'),
  };
};

const toSkill = (input: CreateSkillInput): Skill => {
  const parsed = parseFrontmatter(input.content);
  const now = Date.now();
  return decodeSkill({
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    content: input.content,
    createdAt: now,
    updatedAt: now,
    ...(parsed.license === undefined ? {} : { license: parsed.license }),
    ...(parsed.compatibility === undefined ? {} : { compatibility: parsed.compatibility }),
    ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
    ...(input.source === undefined ? {} : { source: input.source }),
  });
};

const decodeSkillRow = (row: unknown): Skill => {
  const skill = row as {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly license?: string | null;
    readonly compatibility?: string | null;
    readonly allowedTools?: string | null;
    readonly source?: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
  };

  return decodeSkill({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    ...(skill.license == null ? {} : { license: skill.license }),
    ...(skill.compatibility == null ? {} : { compatibility: skill.compatibility }),
    ...(skill.allowedTools == null ? {} : { allowedTools: skill.allowedTools }),
    ...(skill.source == null ? {} : { source: skill.source }),
  });
};

const upsertSkill = (input: CreateSkillInput) =>
  tryPromise(async () => {
    const skill = toSkill(decodeCreateSkillInput(input));
    const existing = await db.select().from(skillsTable).where(eq(skillsTable.id, skill.id)).limit(1).all();
    const next = { ...skill, createdAt: existing[0]?.createdAt ?? skill.createdAt, updatedAt: Date.now() };
    await db.insert(skillsTable).values(next).onConflictDoUpdate({ target: skillsTable.id, set: next }).run();
    return decodeSkill(next);
  });

const findSkillFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const { stdout } = await execFileAsync('rg', ['--files', '--hidden', '--no-ignore', '-g', 'SKILL.md', dir]);
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
};

const pullSkills = (input: PullSkillsInput) =>
  tryPromise(async () => {
    const validated = decodePullSkillsInput(input);
    const dir = await mkdtemp(join(tmpdir(), 'agentdock-skills-'));
    try {
      const args = ['skills', 'add', validated.source, '--global', '-a', 'universal', '--copy', '-y'];
      for (const skill of validated.skills) args.push('--skill', skill);
      if (validated.skills.length === 0) args.push('--skill', '*');
      await execFileAsync('npx', args, { cwd: dir, env: { ...process.env, HOME: dir, DISABLE_TELEMETRY: '1' } });

      const files = await findSkillFiles(dir);
      const imported: Array<Skill> = [];
      for (const file of files) {
        const content = await readFile(file, 'utf8');
        imported.push(toSkill({ content, source: validated.source }));
      }
      for (const skill of imported) {
        const existing = await db.select().from(skillsTable).where(eq(skillsTable.id, skill.id)).limit(1).all();
        const next = { ...skill, createdAt: existing[0]?.createdAt ?? skill.createdAt, updatedAt: Date.now() };
        await db.insert(skillsTable).values(next).onConflictDoUpdate({ target: skillsTable.id, set: next }).run();
      }
      return decodeSkillList(imported);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

export const SkillRegistry = Context.Service<SkillRegistryService>('@agentdock/api/SkillRegistry');

export const SkillRegistryLive = Layer.effect(
  SkillRegistry,
  Effect.succeed(SkillRegistry.of({
    list: () => tryPromise(() => db.select().from(skillsTable).all()).pipe(Effect.map((rows) => decodeSkillList(rows.map(decodeSkillRow)))),
    add: upsertSkill,
    pull: pullSkills,
    remove: (skillId) =>
      tryPromise(async () => {
        const result = await db.delete(skillsTable).where(eq(skillsTable.id, skillId)).run();
        const agents = await db.select().from(agentsTable).all();
        for (const agent of agents) {
          if (!agent.skillIds.includes(skillId)) continue;
          await db.update(agentsTable)
            .set({ skillIds: agent.skillIds.filter((id) => id !== skillId) })
            .where(eq(agentsTable.id, agent.id))
            .run();
        }
        return result.rowsAffected > 0;
      }),
    assignToAgent: (agentId, skillIds) =>
      tryPromise(async () => {
        const validated = decodeAssignAgentSkillsInput({ skillIds });
        const skills = validated.skillIds.length > 0
          ? await db.select({ id: skillsTable.id }).from(skillsTable).where(inArray(skillsTable.id, [...validated.skillIds])).all()
          : [];
        if (skills.length !== validated.skillIds.length) throw new Error('One or more skills do not exist.');
        const result = await db.update(agentsTable).set({ skillIds: validated.skillIds }).where(eq(agentsTable.id, agentId)).run();
        return result.rowsAffected > 0;
      }),
    loadForAgent: (agentId, skillId) =>
      tryPromise(async () => {
        const agents = await db.select({ skillIds: agentsTable.skillIds }).from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).all();
        if (!agents[0]?.skillIds.includes(skillId)) return null;
        const skills = await db.select().from(skillsTable).where(eq(skillsTable.id, skillId)).limit(1).all();
        return skills[0] ? decodeSkillRow(skills[0]) : null;
      }),
  })),
);
