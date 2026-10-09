import { createElement } from 'react';

export function BootScreen() {
  return createElement(
    'div',
    {
      className: 'flex h-dvh items-center justify-center bg-background text-foreground',
      role: 'status',
      'aria-label': 'Loading Agentdock',
    },
    createElement(
      'div',
      { className: 'flex flex-col items-center gap-4' },
      createElement('span', { className: 'text-xl font-semibold tracking-tight' }, 'Agentdock'),
      createElement('div', {
        'aria-hidden': true,
        className: 'h-1 w-24 rounded-full bg-muted motion-safe:animate-pulse',
      }),
      createElement('span', { className: 'sr-only' }, 'Loading…'),
    ),
  );
}
