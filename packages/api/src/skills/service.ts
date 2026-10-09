import * as NodeServices from '@effect/platform-node/NodeServices';
import { type CreateSkillInput, type PullSkillsInput, Skill, SkillList } from 'agentdock-sdk/schemas';
import { agentsTable, Database, type DatabaseClient, DatabaseLive, skillsTable, tryDbWith } from 'db';
import { eq } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { SkillImporter, SkillImporterLive } from './importer';
import { type SkillParseError, SkillParser, SkillParserLive } from './parser';

export type SkillRegistryService = {
  readonly list: () => Effect.Effect<ReadonlyArray<Skill>, SkillRegistryError>;
  readonly listBuiltin: () => ReadonlyArray<Skill>;
  readonly get: (skillId: string) => Effect.Effect<Skill | null, SkillRegistryError>;
  readonly add: (input: CreateSkillInput) => Effect.Effect<Skill, SkillRegistryError | SkillParseError>;
  readonly pull: (input: PullSkillsInput) => Effect.Effect<ReadonlyArray<Skill>, SkillRegistryError>;
  readonly remove: (skillId: string) => Effect.Effect<boolean, SkillRegistryError>;
};

export class SkillRegistryError extends Schema.TaggedError<SkillRegistryError>()('SkillRegistryError', {
  cause: Schema.Defect(),
}) {}

const decodeSkill = Schema.decodeUnknownSync(Skill);
const decodeSkillList = Schema.decodeUnknownSync(SkillList);
const toSkillRegistryError = (cause: unknown): SkillRegistryError => new SkillRegistryError({ cause });
const tryDb = tryDbWith(toSkillRegistryError);

type SkillRow = typeof skillsTable.$inferSelect;

const decodeSkillRow = (row: SkillRow): Skill =>
  decodeSkill({
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    license: row.license ?? undefined,
    compatibility: row.compatibility ?? undefined,
    allowedTools: row.allowedTools ?? undefined,
    source: row.source ?? undefined,
    builtin: false,
  });

const upsertSkill = Effect.fn('SkillRegistry.upsertSkill')(function* (db: DatabaseClient, skill: Skill) {
  const updatedAt = yield* Clock.currentTimeMillis;
  return yield* tryDb(async () => {
    const existing = await db.select().from(skillsTable).where(eq(skillsTable.id, skill.id)).limit(1).all();
    const next = { ...skill, createdAt: existing[0]?.createdAt ?? skill.createdAt, updatedAt };
    await db.insert(skillsTable).values(next).onConflictDoUpdate({ target: skillsTable.id, set: next }).run();
    return decodeSkill(next);
  });
});

/** Each folder under `builtin/` holds one SKILL.md shipped with the server. */
const loadBuiltinSkills = Effect.fn('SkillRegistry.loadBuiltinSkills')(function* (parser: typeof SkillParser.Service) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, 'builtin');
  const folders = yield* fs.readDirectory(root);
  return yield* Effect.forEach(folders.toSorted(), (folder) =>
    fs.readFileString(path.join(root, folder, 'SKILL.md')).pipe(
      Effect.flatMap((content) => parser.parse({ content, source: 'builtin' })),
      Effect.map((skill): Skill => ({ ...skill, builtin: true, createdAt: 0, updatedAt: 0 })),
    ),
  );
});

const builtinConflict = (skillId: string) =>
  new SkillRegistryError({ cause: new Error(`Skill "${skillId}" ships with Agentdock and cannot be replaced.`) });

export const SkillRegistry = Context.Service<SkillRegistryService>('@agentdock/api/SkillRegistry');

const SkillRegistryLayer = Layer.effect(
  SkillRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const parser = yield* SkillParser;
    const importer = yield* SkillImporter;
    const changes = yield* ChangeFeed;
    const builtin = yield* loadBuiltinSkills(parser).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    const builtinById = new Map<string, Skill>(builtin.map((skill) => [skill.id, skill]));

    const store = Effect.fn('SkillRegistry.store')(function* (skill: Skill) {
      if (builtinById.has(skill.id)) return yield* builtinConflict(skill.id);
      return yield* upsertSkill(db, skill);
    });

    return SkillRegistry.of({
      list: () =>
        tryDb(() => db.select().from(skillsTable).all()).pipe(
          Effect.map((rows) => decodeSkillList([...builtin, ...rows.map(decodeSkillRow)])),
        ),
      listBuiltin: () => builtin,
      get: (skillId) => {
        const shipped = builtinById.get(skillId);
        if (shipped) return Effect.succeed(shipped);
        return tryDb(() => db.select().from(skillsTable).where(eq(skillsTable.id, skillId)).limit(1).all()).pipe(
          Effect.map(([row]) => (row ? decodeSkillRow(row) : null)),
        );
      },
      add: Effect.fn('SkillRegistry.add')(function* (input) {
        return yield* store(yield* parser.parse(input));
      }, changes.touches('skills')),
      pull: Effect.fn('SkillRegistry.pull')(function* (input) {
        const imported = yield* importer
          .pull(input)
          .pipe(Effect.mapError((error) => new SkillRegistryError({ cause: error.cause })));
        return decodeSkillList(yield* Effect.forEach(imported, store));
      }, changes.touches('skills')),
      remove: (skillId) =>
        builtinById.has(skillId)
          ? Effect.succeed(false)
          : tryDb(async () => {
              const result = await db.delete(skillsTable).where(eq(skillsTable.id, skillId)).run();
              const agents = await db.select().from(agentsTable).all();
              for (const agent of agents) {
                if (!(skillId in agent.skills)) continue;
                const skills = Object.fromEntries(Object.entries(agent.skills).filter(([id]) => id !== skillId));
                await db.update(agentsTable).set({ skills }).where(eq(agentsTable.id, agent.id)).run();
              }
              return result.rowsAffected > 0;
            }).pipe(changes.touches('skills', 'agents')),
    });
  }),
);

const SkillImporterProvided = SkillImporterLive.pipe(Layer.provide(SkillParserLive));

export const SkillRegistryLive = SkillRegistryLayer.pipe(
  Layer.provide(Layer.mergeAll(SkillParserLive, SkillImporterProvided)),
  Layer.provide(Layer.mergeAll(DatabaseLive, ChangeFeedLive)),
);
