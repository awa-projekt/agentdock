/** Shared formatting and parsing helpers used across views. */

import { ApiFailure, describeApiFailure } from 'agentdock-sdk/schemas';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

export const parseList = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatList = (values: ReadonlyArray<string>): string => (values.length > 0 ? values.join(', ') : '—');

/** Pretty-print a JSON string if it parses cleanly; otherwise return it unchanged. */
export const tryFormatJson = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
};

const isApiFailure = Schema.is(ApiFailure);

export const toErrorMessage = (cause: unknown, fallback: string): string => {
  if (isApiFailure(cause)) return describeApiFailure(cause);
  return cause instanceof Error ? cause.message : fallback;
};

const formatWith =
  (options: Intl.DateTimeFormatOptions) =>
  (value: number | string | null | undefined, fallback: string): string => {
    if (value === null || value === undefined || value === '') return fallback;
    return Option.match(DateTime.make(value), {
      onNone: () => fallback,
      onSome: (dateTime) => DateTime.formatLocal(dateTime, options),
    });
  };

const formatDateTimeWith = formatWith({ dateStyle: 'medium', timeStyle: 'medium' });
const formatTimeWith = formatWith({ timeStyle: 'medium' });
const formatShortTimeWith = formatWith({ hour: 'numeric', minute: '2-digit' });

export const formatDateTime = (value: number | string | null | undefined, fallback = '—'): string =>
  formatDateTimeWith(value, fallback);

export const formatTime = (value: number | string | null | undefined, fallback = '—'): string =>
  formatTimeWith(value, fallback);

export const formatShortTime = (value: number | string | null | undefined, fallback = '—'): string =>
  formatShortTimeWith(value, fallback);

export const formatInteger = (value: number): string => value.toLocaleString();

const unixNanoToMillis = (unixNano: string): number | null => {
  if (!/^\d+$/.test(unixNano) || unixNano === '0') return null;
  const millis = Number(BigInt(unixNano) / 1_000_000n);
  return Number.isFinite(millis) ? millis : null;
};

export const formatUnixNano = (unixNano: string): string => formatDateTime(unixNanoToMillis(unixNano));

export const formatRelative = (unixNano: string): string => {
  const millis = unixNanoToMillis(unixNano);
  if (millis === null) return '—';
  const diffMs = DateTime.toEpochMillis(DateTime.nowUnsafe()) - millis;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const formatTokens = (count: number): string => {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
};

export const formatCost = (usd: number): string => {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const compactText = (value: string, maxLength = 180): string => {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

export const pluralise = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export const nowMillis = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

export const formatUntil = (millis: number): string => {
  const seconds = Math.round((millis - nowMillis()) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86_400)}d`;
};
