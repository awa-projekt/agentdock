import type { Trigger } from 'agentdock-sdk/schemas';
import type { TriggerPayload } from 'agentdock-sdk/triggers';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';
import { TriggerConfig } from '../config';
import { nextCronDate } from './cron';
import { TriggerDispatcher } from './dispatch';
import { EmailSource, type NormalizedEmail } from './email/source';
import { TriggerRegistry } from './service';

/** Retry a failed dispatch a bounded number of times before recording failure. */
const DISPATCH_RETRIES = 2;

/** Next cron fire time, or undefined if the expression is (now) invalid. */
const computeNextRunAt = (cron: string, from: Date): string | undefined => {
  try {
    return nextCronDate(cron, from).toISOString();
  } catch {
    return undefined;
  }
};

const emailMatches = (trigger: Trigger, email: NormalizedEmail): boolean => {
  if (trigger.spec.type !== 'email') {
    return false;
  }
  const match = trigger.spec.match;
  if (match?.from && !email.from.toLowerCase().includes(match.from.toLowerCase())) {
    return false;
  }
  if (match?.subjectContains && !email.subject.toLowerCase().includes(match.subjectContains.toLowerCase())) {
    return false;
  }
  return true;
};

const emailPayload = (email: NormalizedEmail): TriggerPayload => ({
  id: email.id,
  mailbox: email.mailbox,
  subject: email.subject,
  from: email.from,
  receivedDateTime: email.receivedDateTime,
  bodyPreview: email.bodyPreview,
  body: email.body,
});

export const TriggerSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* TriggerRegistry;
    const dispatcher = yield* TriggerDispatcher;
    const emailSource = yield* EmailSource;
    const config = yield* TriggerConfig;

    /** Fire one schedule trigger: advance its next fire time first, then dispatch. */
    const fireSchedule = Effect.fn('TriggerScheduler.fireSchedule')(function* (trigger: Trigger) {
      if (trigger.spec.type !== 'schedule') {
        return;
      }

      const firedAt = yield* DateTime.nowAsDate;
      const lastRunAt = firedAt.toISOString();
      // Compute the next fire time from now (fire-once, no backfill) and persist it
      // before dispatching so an overlapping tick cannot double-fire.
      const nextRunAt = computeNextRunAt(trigger.spec.cron, firedAt);
      if (nextRunAt === undefined) {
        yield* Effect.logWarning(
          `trigger ${trigger.id}: cron '${trigger.spec.cron}' is invalid; no next run scheduled`,
        );
      }

      const payload: TriggerPayload = { trigger: { id: trigger.id, name: trigger.name }, firedAt: lastRunAt };
      const nextRun = nextRunAt !== undefined ? { nextRunAt } : {};

      yield* dispatcher.dispatch(trigger, payload, 'schedule').pipe(
        Effect.retry(Schedule.recurs(DISPATCH_RETRIES)),
        Effect.flatMap(() => registry.markScheduleFired(trigger.id, { lastRunAt, ...nextRun })),
        Effect.catch((error) =>
          registry
            .markScheduleFired(trigger.id, { lastRunAt, ...nextRun, lastError: error.message })
            .pipe(Effect.andThen(Effect.logWarning(`trigger ${trigger.id} dispatch failed: ${error.message}`))),
        ),
        Effect.catch((error) => Effect.logError(`trigger ${trigger.id} bookkeeping failed`, error)),
      );
    });

    const processSchedules = Effect.fn('TriggerScheduler.processSchedules')(
      function* () {
        const due = yield* registry.listDueSchedules(DateTime.formatIso(yield* DateTime.now));
        yield* Effect.forEach(due, fireSchedule, { discard: true });
      },
      Effect.catch((error) => Effect.logError('scheduler: schedule pass failed', error)),
    );

    /** Poll one mailbox and dispatch matching email triggers. */
    const pollMailbox = Effect.fn('TriggerScheduler.pollMailbox')(function* (
      mailbox: string,
      triggers: ReadonlyArray<Trigger>,
    ) {
      const watermark = yield* registry.getEmailWatermark(mailbox);
      if (watermark === null) {
        // First sighting of this mailbox: start from now, never backfill history.
        yield* registry.setEmailWatermark(mailbox, DateTime.formatIso(yield* DateTime.now));
        return;
      }

      const messages = yield* emailSource.fetchSince(mailbox, watermark);
      for (const email of messages) {
        for (const trigger of triggers) {
          if (emailMatches(trigger, email)) {
            yield* dispatcher.dispatch(trigger, emailPayload(email), 'email').pipe(
              Effect.retry(Schedule.recurs(DISPATCH_RETRIES)),
              Effect.catch((error) =>
                Effect.logWarning(`email trigger ${trigger.id} dispatch failed: ${error.message}`),
              ),
            );
          }
        }
        yield* registry.setEmailWatermark(mailbox, email.receivedDateTime);
      }
    });

    const processEmail = Effect.fn('TriggerScheduler.processEmail')(
      function* () {
        if (!emailSource.enabled) {
          return;
        }

        const triggers = yield* registry.listEnabledEmail();
        const byMailbox = new Map<string, Array<Trigger>>();
        for (const trigger of triggers) {
          if (trigger.spec.type === 'email') {
            const list = byMailbox.get(trigger.spec.mailbox) ?? [];
            list.push(trigger);
            byMailbox.set(trigger.spec.mailbox, list);
          }
        }

        yield* Effect.forEach(
          [...byMailbox.entries()],
          ([mailbox, mailboxTriggers]) =>
            pollMailbox(mailbox, mailboxTriggers).pipe(
              Effect.catch((error) => Effect.logError(`scheduler: mailbox ${mailbox} poll failed`, error)),
            ),
          { discard: true },
        );
      },
      Effect.catch((error) => Effect.logError('scheduler: email pass failed', error)),
    );

    const tick = processSchedules().pipe(Effect.andThen(processEmail()));

    yield* Effect.logInfo(
      `trigger scheduler started (every ${config.schedulerIntervalSeconds}s, email ${emailSource.enabled ? 'enabled' : 'disabled'})`,
    );
    yield* Effect.forkScoped(
      tick.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(config.schedulerIntervalSeconds)))),
    );
  }),
);
