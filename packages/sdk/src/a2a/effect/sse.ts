import { Stream } from 'effect';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new TextEncoder();

export const formatSSEEvent = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

export const formatSSEErrorEvent = (error: unknown): string =>
  `event: error\ndata: ${JSON.stringify(error)}\n\n`;

export const sseTextStream = (iterable: AsyncIterable<string>) =>
  Stream.fromAsyncIterable(iterable, () => new Error('SSE stream failure')).pipe(
    Stream.map((chunk) => encoder.encode(chunk)),
  );
