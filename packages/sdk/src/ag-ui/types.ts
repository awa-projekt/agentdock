import type { Interrupt } from '@ag-ui/core';

export type {
  AGUIEvent as AgUiEvent,
  Interrupt as AgUiInterrupt,
  RunAgentInput as AgUiRunAgentInput,
} from '@ag-ui/core';
export {
  EventSchemas as AgUiEventSchema,
  EventType as AgUiEventType,
  RunAgentInputSchema as AgUiRunInputSchema,
} from '@ag-ui/core';

export type AgUiRunOutcome =
  | { readonly status: 'completed'; readonly result?: unknown }
  | { readonly status: 'input-required'; readonly interrupts: Interrupt[] }
  | { readonly status: 'canceled' }
  | { readonly status: 'failed'; readonly message: string };
