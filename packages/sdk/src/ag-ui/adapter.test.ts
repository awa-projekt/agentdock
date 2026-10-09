import { describe, expect, it } from '@effect/vitest';
import { AgUiEventAdapter, graphEventToAgUi, streamAgentRunAsAgUi } from './adapter';
import { graphInterrupts, interruptAddress } from './interrupts';
import { AgUiEventSchema, AgUiEventType, AgUiRunInputSchema } from './types';

describe('AG-UI graph projection', () => {
  it('emits schema-valid reasoning, tool and message events with native tool IDs', () => {
    const adapter = new AgUiEventAdapter('thread', 'run');
    const events = [
      adapter.start(),
      ...graphEventToAgUi(adapter, { type: 'reasoning', text: 'Checking' }),
      ...graphEventToAgUi(adapter, {
        type: 'tool-call',
        toolCallId: 'native-call',
        toolName: 'lookup',
        input: { query: 'item' },
      }),
      ...graphEventToAgUi(adapter, {
        type: 'tool-result',
        toolCallId: 'native-call',
        toolName: 'lookup',
        output: { found: true },
      }),
      ...adapter.handle({ type: 'text-delta', text: 'Found it' }),
      ...adapter.finish({ status: 'completed' }),
    ];
    for (const event of events) expect(AgUiEventSchema.safeParse(event).success).toBe(true);
    expect(events.find((event) => event.type === AgUiEventType.TOOL_CALL_RESULT)).toMatchObject({
      toolCallId: 'native-call',
      messageId: 'native-call:result',
    });
  });

  it('preserves every parallel interrupt address through the official resume contract', async () => {
    const interrupts = graphInterrupts('task', {
      interrupts: [
        { id: 'left', value: { title: 'Left approval' } },
        { id: 'right', value: { title: 'Right approval' } },
      ],
    });
    const events = [];
    for await (const event of streamAgentRunAsAgUi({ threadId: 'thread', runId: 'run' }, async () => ({
      status: 'input-required',
      interrupts,
    }))) {
      events.push(AgUiEventSchema.parse(event));
    }
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'interrupt', interrupts } });
    const input = AgUiRunInputSchema.parse({
      threadId: 'thread',
      runId: 'resume-run',
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      resume: interrupts.map((entry) => ({ interruptId: entry.id, status: 'resolved', payload: true })),
    });
    expect(input.resume?.map((entry) => interruptAddress.parse(JSON.parse(entry.interruptId)))).toEqual([
      ['task', 'left'],
      ['task', 'right'],
    ]);
  });
});
