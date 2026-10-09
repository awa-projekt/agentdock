/**
 * Minimal 5-field cron parser: `minute hour day-of-month month day-of-week`.
 * Each field supports `*`, `*​/n`, single values, `a-b` ranges, comma lists, and
 * `a-b/n` step-over-range. Day-of-week is 0-6 (Sunday = 0; 7 also accepted as
 * Sunday). When both day-of-month and day-of-week are restricted, a minute
 * matches if either field matches (standard cron behaviour).
 *
 * This is intentionally small — enough for schedules like `*​/5 * * * *` — and
 * computes the next fire time by stepping minute by minute, bounded so a
 * never-matching expression fails loudly instead of looping forever.
 */

import * as DateTime from 'effect/DateTime';

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

type Field = { readonly values: ReadonlySet<number>; readonly restricted: boolean };

const parseField = (raw: string, min: number, max: number): Field => {
  const values = new Set<number>();
  let restricted = true;

  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`invalid step '${stepPart}' in cron field '${raw}'`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === undefined || rangePart === '') {
      lo = min;
      hi = max;
      if (rangePart === '*') {
        restricted = restricted && stepPart !== undefined;
      }
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new CronParseError(`cron field '${raw}' is out of range [${min}-${max}]`);
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  if (values.size === 0) {
    throw new CronParseError(`cron field '${raw}' matches nothing`);
  }

  return { values, restricted };
};

type CronSchedule = {
  readonly minute: Field;
  readonly hour: Field;
  readonly dom: Field;
  readonly month: Field;
  readonly dow: Field;
};

export const parseCron = (expression: string): CronSchedule => {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, dom, month, dowRaw] = fields;
  if (
    fields.length !== 5 ||
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    month === undefined ||
    dowRaw === undefined
  ) {
    throw new CronParseError(`cron expression must have 5 fields, got ${fields.length}: '${expression}'`);
  }

  // Normalise day-of-week 7 -> 0 (Sunday) before parsing the 0-6 range.
  const dow = dowRaw.replace(/\b7\b/g, '0');

  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dow: parseField(dow, 0, 6),
  };
};

const matches = (schedule: CronSchedule, date: Date): boolean => {
  if (!schedule.minute.values.has(date.getMinutes())) return false;
  if (!schedule.hour.values.has(date.getHours())) return false;
  if (!schedule.month.values.has(date.getMonth() + 1)) return false;

  const domOk = schedule.dom.values.has(date.getDate());
  const dowOk = schedule.dow.values.has(date.getDay());

  // Standard cron: if both day fields are restricted, OR them; otherwise AND.
  return schedule.dom.restricted && schedule.dow.restricted ? domOk || dowOk : domOk && dowOk;
};

const MAX_MINUTES = 366 * 24 * 60;

/** The first fire time strictly after `from`. Throws if none within ~1 year. */
export const nextCronDate = (expression: string, from: Date): Date => {
  const schedule = parseCron(expression);
  const candidate = DateTime.toDateUtc(DateTime.makeUnsafe(from));
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_MINUTES; i += 1) {
    if (matches(schedule, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new CronParseError(`cron expression '${expression}' has no fire time within a year`);
};
