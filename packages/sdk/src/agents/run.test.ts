import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { jsonString } from '../schemas/json';
import type { AgentDefinition } from './definition';
import type { AgentLoop, AgentLoopEvent, AgentLoopOutcome } from './loop';
import { AgentLoopFactory } from './loop';
import { ModelProvider } from './model-provider';
import { runAgent } from './run';
import { AgentRunStore } from './run-store';
import { AgentToolResolver } from './tool-resolver';

// `runAgent` is tested against fakes for every service it depends on — the
// persistence — so these tests exercise only `runAgent`'s own orchestration:
// record lifecycle, event bookkeeping, and outcome interpretation.

const modelProviderStub: Layer.Layer<ModelProvider> = Layer.succeed(
  ModelProvider,
  ModelProvider.of({
    resolve: (model) => {
      const separatorIndex = model.indexOf(':');
      return Effect.succeed({
        model,
        provider: separatorIndex === -1 ? model : model.slice(0, separatorIndex),
        modelId: separatorIndex === -1 ? '' : model.slice(separatorIndex + 1),
      });
    },
  }),
);

const noToolsLayer = AgentToolResolver.static([]);

/** A scripted `AgentLoopFactory`: emits the given events, then resolves with `outcome`. */
const scriptedLoopFactory = (
  script: ReadonlyArray<{ readonly events: ReadonlyArray<AgentLoopEvent>; readonly outcome: AgentLoopOutcome }>,
  calls: Array<{ readonly threadId: string }> = [],
): Layer.Layer<AgentLoopFactory> => {
  let call = 0;
  return Layer.succeed(
    AgentLoopFactory,
    AgentLoopFactory.of({
      create: () =>
        Effect.succeed<AgentLoop>({
          stream: (_input, options) =>
            Effect.sync(() => {
              calls.push({ threadId: options.threadId });
              const step = script[Math.min(call, script.length - 1)];
              call++;
              for (const event of step?.events ?? []) void options.onEvent(event);
              return step?.outcome ?? { text: '', interrupted: false };
            }),
        }),
    }),
  );
};

const testLayer = (loopLayer: Layer.Layer<AgentLoopFactory>) =>
  Layer.mergeAll(loopLayer, modelProviderStub, noToolsLayer, AgentRunStore.inMemory);

const agent: AgentDefinition = {
  id: 'agent-1',
  name: 'Test Agent',
  instructions: 'be helpful',
  model: 'anthropic:claude',
};

describe('runAgent', () => {
  it.effect('can leave persistence to a transport-owned task store', () => {
    const loopLayer = scriptedLoopFactory([{ events: [], outcome: { text: 'Hello', interrupted: false } }]);
    const transportOwnedStore = Layer.succeed(
      AgentRunStore,
      AgentRunStore.of({
        save: () => Effect.die('save should not be called'),
        get: () => Effect.die('get should not be called'),
        listByContext: () => Effect.die('listByContext should not be called'),
        listByWorkflowRun: () => Effect.die('listByWorkflowRun should not be called'),
        delete: () => Effect.die('delete should not be called'),
      }),
    );
    const layer = Layer.mergeAll(loopLayer, modelProviderStub, noToolsLayer, transportOwnedStore);

    return Effect.gen(function* () {
      const result = yield* runAgent(
        agent,
        { parts: [{ kind: 'text', text: 'hi' }] },
        { taskId: 'task-1', contextId: 'context-1', persist: false },
      );

      expect(result.status).toBe('completed');
      expect(result.record.status.state).toBe('completed');
    }).pipe(Effect.provide(layer));
  });

  it.effect('records a completed text run: history, artifacts, and status', () => {
    const loopLayer = scriptedLoopFactory([
      {
        events: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: { q: 'weather' } },
          { type: 'tool-result', toolCallId: 'call-1', toolName: 'search', output: { ok: true } },
          { type: 'reasoning', text: 'thinking it through' },
        ],
        outcome: { text: 'Hello world', interrupted: false },
      },
    ]);

    return Effect.gen(function* () {
      const result = yield* runAgent(agent, { parts: [{ kind: 'text', text: 'hi there' }] });

      expect(result.status).toBe('completed');
      expect(result.text).toBe('Hello world');
      expect(result.record.status.state).toBe('completed');
      expect(result.record.artifacts).toHaveLength(1);
      expect(result.record.artifacts[0]?.parts).toEqual([{ kind: 'text', text: 'Hello world' }]);

      const historyKinds = result.record.history.map((message) =>
        message.parts[0]?.kind === 'data' ? jsonString(message.parts[0].data, 'type') : message.role,
      );
      // user message, then tool-call/tool-result/reasoning data messages, then the final agent message.
      expect(historyKinds).toEqual(['user', 'tool-call', 'tool-result', 'reasoning', 'agent']);
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('records a structured outcome as a data artifact', () => {
    const structuredAgent: AgentDefinition = { ...agent, outputSchema: { type: 'object' } };
    const loopLayer = scriptedLoopFactory([
      { events: [], outcome: { text: '', structuredResponse: { answer: 42 }, interrupted: false } },
    ]);

    return Effect.gen(function* () {
      const result = yield* runAgent(structuredAgent, { parts: [{ kind: 'text', text: 'compute' }] });

      expect(result.status).toBe('completed');
      expect(result.structured).toEqual({ answer: 42 });
      expect(result.record.artifacts[0]?.parts).toEqual([{ kind: 'data', data: { answer: 42 } }]);
      expect(result.record.status.message?.parts).toEqual([{ kind: 'data', data: { answer: 42 } }]);
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('goes to input-required when a tool result carries the input-required envelope', () => {
    const loopLayer = scriptedLoopFactory([
      {
        events: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'ask_human',
            output: { status: 'input-required', request: { question: 'confirm?' } },
          },
        ],
        outcome: { text: '', interrupted: false },
      },
    ]);

    return Effect.gen(function* () {
      const result = yield* runAgent(agent, { parts: [{ kind: 'text', text: 'hi' }] });

      expect(result.status).toBe('input-required');
      expect(result.inputRequired).toEqual({ question: 'confirm?' });
      expect(result.record.status.state).toBe('input-required');
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('goes to input-required when the harness itself interrupts', () => {
    const loopLayer = scriptedLoopFactory([
      { events: [], outcome: { text: '', interrupted: true, interrupts: { reason: 'needs-approval' } } },
    ]);

    return Effect.gen(function* () {
      const result = yield* runAgent(agent, { parts: [{ kind: 'text', text: 'hi' }] });

      expect(result.status).toBe('input-required');
      expect(result.inputRequired).toEqual({
        type: 'input-required',
        source: 'agent-loop-interrupt',
        interrupts: { reason: 'needs-approval' },
      });
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('forwards every loop event to the caller-supplied onEvent', () => {
    const scriptedEvents: ReadonlyArray<AgentLoopEvent> = [
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: {} },
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'search', output: {} },
      { type: 'finish', finishReason: 'stop', usage: { totalTokens: 10 } },
    ];
    const loopLayer = scriptedLoopFactory([{ events: scriptedEvents, outcome: { text: 'done', interrupted: false } }]);
    const forwarded: Array<AgentLoopEvent> = [];

    return Effect.gen(function* () {
      yield* runAgent(
        agent,
        { parts: [{ kind: 'text', text: 'hi' }] },
        { onEvent: (event) => void forwarded.push(event) },
      );

      expect(forwarded).toEqual(scriptedEvents);
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('appends to the same record and reuses the threadId on continuation', () => {
    const calls: Array<{ readonly threadId: string }> = [];
    const loopLayer = scriptedLoopFactory(
      [
        { events: [], outcome: { text: 'first turn', interrupted: false } },
        { events: [], outcome: { text: 'second turn', interrupted: false } },
      ],
      calls,
    );

    return Effect.gen(function* () {
      const first = yield* runAgent(agent, { parts: [{ kind: 'text', text: 'turn one' }] });
      const second = yield* runAgent(agent, { parts: [{ kind: 'text', text: 'turn two' }] }, { taskId: first.taskId });

      expect(second.taskId).toBe(first.taskId);
      expect(second.contextId).toBe(first.contextId);
      expect(second.record.history.map((m) => (m.parts[0]?.kind === 'text' ? m.parts[0].text : undefined))).toEqual([
        'turn one',
        'first turn',
        'turn two',
        'second turn',
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.threadId).toBe(calls[1]?.threadId);
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });

  it.effect('lists runs by workflowRunId when origin is a workflow invocation', () => {
    const loopLayer = scriptedLoopFactory([{ events: [], outcome: { text: 'ok', interrupted: false } }]);

    return Effect.gen(function* () {
      const result = yield* runAgent(
        agent,
        { parts: [{ kind: 'text', text: 'run inside workflow' }] },
        {
          origin: { surface: 'workflow', workflowId: 'wf-1', workflowRunId: 'wfr-1', stepId: 'node-1', attempt: 1 },
        },
      );
      const store = yield* AgentRunStore;
      const listed = yield* store.listByWorkflowRun('wfr-1');

      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(result.taskId);
      expect(listed[0]?.origin).toEqual({
        surface: 'workflow',
        workflowId: 'wf-1',
        workflowRunId: 'wfr-1',
        stepId: 'node-1',
        attempt: 1,
      });
    }).pipe(Effect.provide(testLayer(loopLayer)));
  });
});
