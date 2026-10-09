import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';
import { CronParseError, nextCronDate, parseCron } from './cron';

/** `nextCronDate` matches cron fields against local wall-clock time, so the fixtures are local too. */
const localDate = (wallClock: string): Date =>
  DateTime.toDateUtc(
    DateTime.makeZonedUnsafe(wallClock, { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true }),
  );

describe('parseCron', () => {
  it('rejects expressions without 5 fields', () => {
    expect(() => parseCron('* * * *')).toThrow(CronParseError);
    expect(() => parseCron('* * * * * *')).toThrow(CronParseError);
  });

  it('rejects out-of-range fields', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('* 24 * * *')).toThrow(CronParseError);
  });
});

describe('nextCronDate', () => {
  it('advances to the next 5-minute boundary', () => {
    const from = localDate('2026-06-17T10:02:30');
    const next = nextCronDate('*/5 * * * *', from);
    expect(next.getMinutes()).toBe(5);
    expect(next.getHours()).toBe(10);
  });

  it('is strictly after `from` even when the current minute matches', () => {
    const from = localDate('2026-06-17T10:05:00');
    const next = nextCronDate('*/5 * * * *', from);
    expect(next.getMinutes()).toBe(10);
  });

  it('rolls to the next day for a daily time already passed', () => {
    const from = localDate('2026-06-17T10:00:00');
    const next = nextCronDate('0 9 * * *', from);
    expect(next.getDate()).toBe(18);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('honours day-of-month restrictions', () => {
    const from = localDate('2026-06-17T12:00:00');
    const next = nextCronDate('30 14 1 * *', from);
    expect(next.getDate()).toBe(1);
    expect(next.getMonth()).toBe(6); // July
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });
});
