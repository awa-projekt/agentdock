import { randomUUIDv4 } from 'agentdock-sdk';
import {
  CreateTriggerInput,
  Trigger,
  TriggerList,
  UpdateTriggerInput,
  workflowInputContract,
} from 'agentdock-sdk/schemas';
import { validateTriggerTemplate } from 'agentdock-sdk/triggers';
import { Database, emailPollStateTable, triggerFiringsTable, triggersTable, tryDbWith } from 'db';
import { and, asc, eq, lte } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { WorkflowRegistry } from '../workflows/service';
import { nextCronDate } from './cron';

export type TriggerFiringInput = {
  readonly triggerId: string;
  readonly taskId: string;
  readonly source: 'schedule' | 'webhook' | 'email';
  readonly status: 'dispatched' | 'failed';
  readonly error?: string;
};

export type ScheduleFiredInput = {
  readonly lastRunAt: string;
  readonly nextRunAt?: string;
  readonly lastError?: string;
};

type TriggerRegistryService = {
  readonly list: () => Effect.Effect<ReadonlyArray<Trigger>, TriggerRegistryError>;
  readonly getById: (triggerId: string) => Effect.Effect<Trigger | null, TriggerRegistryError>;
  readonly add: (input: CreateTriggerInput) => Effect.Effect<Trigger, TriggerRegistryError | TriggerValidationError>;
  readonly update: (
    triggerId: string,
    input: UpdateTriggerInput,
  ) => Effect.Effect<Trigger | null, TriggerRegistryError | TriggerValidationError>;
  readonly remove: (triggerId: string) => Effect.Effect<boolean, TriggerRegistryError>;
  readonly listDueSchedules: (nowIso: string) => Effect.Effect<ReadonlyArray<Trigger>, TriggerRegistryError>;
  readonly listEnabledEmail: () => Effect.Effect<ReadonlyArray<Trigger>, TriggerRegistryError>;
  readonly markScheduleFired: (
    triggerId: string,
    input: ScheduleFiredInput,
  ) => Effect.Effect<void, TriggerRegistryError>;
  readonly recordFiring: (input: TriggerFiringInput) => Effect.Effect<void, TriggerRegistryError>;
  readonly getEmailWatermark: (mailbox: string) => Effect.Effect<string | null, TriggerRegistryError>;
  readonly setEmailWatermark: (mailbox: string, watermark: string) => Effect.Effect<void, TriggerRegistryError>;
};

export class TriggerRegistryError extends Schema.TaggedError<TriggerRegistryError>()('TriggerRegistryError', {
  cause: Schema.Defect(),
}) {}

export class TriggerValidationError extends Schema.TaggedError<TriggerValidationError>()('TriggerValidationError', {
  message: Schema.String,
}) {}

const decodeCreateTriggerInput = Schema.decodeUnknownSync(CreateTriggerInput);
const decodeUpdateTriggerInput = Schema.decodeUnknownSync(UpdateTriggerInput);
const decodeTrigger = Schema.decodeUnknownSync(Trigger);
const decodeTriggerList = Schema.decodeUnknownSync(TriggerList);

const triggerId = Effect.map(randomUUIDv4, (id) => `trg_${id.replaceAll('-', '').slice(0, 12)}`);
const firingId = Effect.map(randomUUIDv4, (id) => `trf_${id.replaceAll('-', '').slice(0, 12)}`);

const toTriggerRegistryError = (cause: unknown): TriggerRegistryError => new TriggerRegistryError({ cause });
const tryDb = tryDbWith(toTriggerRegistryError);

type TriggerRow = typeof triggersTable.$inferSelect;

const rowToTrigger = (row: TriggerRow): Trigger =>
  decodeTrigger({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    target: { kind: row.targetKind, id: row.targetId },
    taskTemplate: row.taskTemplate,
    spec: row.spec,
    nextRunAt: row.nextRunAt ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const triggerToRow = (trigger: Trigger): TriggerRow => ({
  id: trigger.id,
  name: trigger.name,
  enabled: trigger.enabled,
  targetKind: trigger.target.kind,
  targetId: trigger.target.id,
  taskTemplate: trigger.taskTemplate,
  specType: trigger.spec.type,
  spec: trigger.spec,
  nextRunAt: trigger.nextRunAt ?? null,
  lastRunAt: trigger.lastRunAt ?? null,
  lastError: trigger.lastError ?? null,
  createdAt: trigger.createdAt,
  updatedAt: trigger.updatedAt,
});

/** Initial `nextRunAt` for a schedule trigger; undefined for webhook/email. */
const initialNextRunAt = (input: CreateTriggerInput): Effect.Effect<string | undefined, TriggerValidationError> => {
  const spec = input.spec;
  if (spec.type !== 'schedule') {
    return Effect.succeed(undefined);
  }

  return Effect.flatMap(DateTime.nowAsDate, (from) =>
    Effect.try({
      try: () => nextCronDate(spec.cron, from).toISOString(),
      catch: (cause) =>
        new TriggerValidationError({
          message: `invalid cron expression: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }),
  );
};

export const TriggerRegistry = Context.Service<TriggerRegistryService>('@agentdock/api/TriggerRegistry');

const TriggerRegistryLayer = Layer.effect(
  TriggerRegistry,
  Effect.gen(function* () {
    const { db } = yield* Database;
    // Trigger rows are plain data assembled inline; the Clock's synchronous
    // accessor keeps their timestamps on `TestClock` without threading an
    // effect through every field.
    const clock = yield* Effect.clockWith(Effect.succeed);
    const nowMs = (): number => clock.currentTimeMillisUnsafe();
    const workflowRegistry = yield* WorkflowRegistry;
    const changes = yield* ChangeFeed;
    const touchesTriggers = changes.touches('triggers');

    /** Reject a template whose parts don't satisfy a workflow target's input contract. */
    const validateAgainstTarget = (
      input: CreateTriggerInput,
    ): Effect.Effect<void, TriggerRegistryError | TriggerValidationError> =>
      Effect.gen(function* () {
        if (input.target.kind !== 'workflow') {
          return;
        }

        const workflow = yield* workflowRegistry.getById(input.target.id).pipe(Effect.mapError(toTriggerRegistryError));
        if (!workflow) {
          return yield* new TriggerValidationError({ message: `target workflow '${input.target.id}' does not exist` });
        }

        const issues = validateTriggerTemplate(workflowInputContract(workflow), input.taskTemplate);
        if (issues.length > 0) {
          return yield* new TriggerValidationError({
            message: `task template is not compatible with the target workflow: ${issues.join('; ')}`,
          });
        }
      });

    return TriggerRegistry.of({
      list: Effect.fn('TriggerRegistry.list')(function* () {
        const rows = yield* tryDb(() => db.select().from(triggersTable).all());
        return decodeTriggerList(rows.map(rowToTrigger));
      }),
      getById: Effect.fn('TriggerRegistry.getById')(function* (id: string) {
        const rows = yield* tryDb(() => db.select().from(triggersTable).where(eq(triggersTable.id, id)).limit(1).all());
        return rows[0] ? rowToTrigger(rows[0]) : null;
      }),
      add: Effect.fn('TriggerRegistry.add')(function* (input: CreateTriggerInput) {
        const validatedInput = decodeCreateTriggerInput(input);
        yield* validateAgainstTarget(validatedInput);
        const nextRunAt = yield* initialNextRunAt(validatedInput);
        const timestamp = nowMs();
        const trigger = decodeTrigger({
          ...validatedInput,
          id: yield* triggerId,
          nextRunAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* tryDb(() => db.insert(triggersTable).values(triggerToRow(trigger)).run());
        return trigger;
      }, touchesTriggers),
      update: Effect.fn('TriggerRegistry.update')(function* (id: string, input: UpdateTriggerInput) {
        const validatedInput = decodeUpdateTriggerInput(input);
        yield* validateAgainstTarget(validatedInput);
        const existingRows = yield* tryDb(() =>
          db.select().from(triggersTable).where(eq(triggersTable.id, id)).limit(1).all(),
        );
        const existing = existingRows[0];
        if (!existing) {
          return null;
        }

        const nextRunAt = yield* initialNextRunAt(validatedInput);
        const trigger = decodeTrigger({
          ...validatedInput,
          id,
          nextRunAt,
          createdAt: existing.createdAt,
          updatedAt: nowMs(),
        });
        const result = yield* tryDb(() =>
          db.update(triggersTable).set(triggerToRow(trigger)).where(eq(triggersTable.id, id)).run(),
        );
        return result.rowsAffected > 0 ? trigger : null;
      }, touchesTriggers),
      remove: Effect.fn('TriggerRegistry.remove')(function* (id: string) {
        const result = yield* tryDb(() => db.delete(triggersTable).where(eq(triggersTable.id, id)).run());
        return result.rowsAffected > 0;
      }, touchesTriggers),
      listDueSchedules: Effect.fn('TriggerRegistry.listDueSchedules')(function* (due: string) {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(triggersTable)
            .where(
              and(
                eq(triggersTable.specType, 'schedule'),
                eq(triggersTable.enabled, true),
                lte(triggersTable.nextRunAt, due),
              ),
            )
            .orderBy(asc(triggersTable.nextRunAt))
            .all(),
        );
        return rows.map(rowToTrigger);
      }),
      listEnabledEmail: Effect.fn('TriggerRegistry.listEnabledEmail')(function* () {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(triggersTable)
            .where(and(eq(triggersTable.specType, 'email'), eq(triggersTable.enabled, true)))
            .all(),
        );
        return rows.map(rowToTrigger);
      }),
      markScheduleFired: Effect.fn('TriggerRegistry.markScheduleFired')(function* (
        id: string,
        input: ScheduleFiredInput,
      ) {
        yield* tryDb(() =>
          db
            .update(triggersTable)
            .set({ lastRunAt: input.lastRunAt, nextRunAt: input.nextRunAt ?? null, lastError: input.lastError ?? null })
            .where(eq(triggersTable.id, id))
            .run(),
        );
      }, touchesTriggers),
      recordFiring: Effect.fn('TriggerRegistry.recordFiring')(function* (input: TriggerFiringInput) {
        const id = yield* firingId;
        yield* tryDb(() =>
          db
            .insert(triggerFiringsTable)
            .values({
              id,
              triggerId: input.triggerId,
              taskId: input.taskId,
              source: input.source,
              status: input.status,
              error: input.error ?? null,
              firedAt: nowMs(),
            })
            .run(),
        );
      }, touchesTriggers),
      getEmailWatermark: Effect.fn('TriggerRegistry.getEmailWatermark')(function* (mailbox: string) {
        const rows = yield* tryDb(() =>
          db.select().from(emailPollStateTable).where(eq(emailPollStateTable.mailbox, mailbox)).limit(1).all(),
        );
        return rows[0]?.watermark ?? null;
      }),
      setEmailWatermark: Effect.fn('TriggerRegistry.setEmailWatermark')(function* (mailbox: string, watermark: string) {
        yield* tryDb(() =>
          db
            .insert(emailPollStateTable)
            .values({ mailbox, watermark, updatedAt: nowMs() })
            .onConflictDoUpdate({ target: emailPollStateTable.mailbox, set: { watermark, updatedAt: nowMs() } })
            .run(),
        );
      }),
    });
  }),
);

export const TriggerRegistryLive = TriggerRegistryLayer.pipe(Layer.provide(ChangeFeedLive));
