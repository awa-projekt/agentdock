import * as Stream from 'effect/Stream';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new TextEncoder();

/**
 * Serializes one already-typed outbound event as an SSE frame. The type
 * parameter keeps each transport's own event contract (a2a, AG-UI) intact
 * instead of widening every stream onto one shared union.
 */
export const formatSSEEvent = <Event>(event: Event): string => `data: ${JSON.stringify(event)}\n\n`;

export const formatSSEErrorEvent = <Failure>(failure: Failure): string =>
  `event: error\ndata: ${JSON.stringify(failure)}\n\n`;

export const sseTextStream = (iterable: AsyncIterable<string>) =>
  Stream.fromAsyncIterable(iterable, () => new Error('SSE stream failure')).pipe(
    Stream.map((chunk) => encoder.encode(chunk)),
  );
