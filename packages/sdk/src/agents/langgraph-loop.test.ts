import { describe, expect, it } from '@effect/vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type StandardMessageStructure } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Annotation, Command, StateGraph } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import * as Effect from 'effect/Effect';
import { z } from 'zod';
import { defineAgentTool } from '../tools';
import { hostRunner } from '../workflows/host-runner';
import { AgentLoopFactoryLive, resumableToolOutput } from './langgraph-loop';
import type { AgentLoopEvent } from './loop';
import { AgentLoopFactory } from './loop';
import { withReasoningEstimate } from './usage';

/** Answers each model call with the next scripted message, tool calls and usage included. */
class ScriptedChatModel extends BaseChatModel {
  private calls = 0;

  constructor(private readonly script: ReadonlyArray<AIMessage<StandardMessageStructure>>) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.calls, this.script.length - 1)] ?? new AIMessage('');
    this.calls += 1;
    return { generations: [{ text: '', message }] };
  }
}

describe('LangGraph AgentLoopFactory', () => {
  it.effect('streams text-delta events and returns the accumulated text', () =>
    Effect.gen(function* () {
      const events: Array<AgentLoopEvent> = [];
      const factory = yield* AgentLoopFactory;
      const loop = yield* factory.create({
        name: 'test-agent',
        model: {
          model: 'test:fake',
          provider: 'test',
          modelId: 'fake',
          config: { chatModel: new FakeListChatModel({ responses: ['Hello from the fake model.'] }) },
        },
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
      });
      const outcome = yield* loop.stream(
        { parts: [{ kind: 'text', text: 'hi' }] },
        { threadId: 'test-thread', onEvent: (event) => void events.push(event) },
      );

      expect(outcome.interrupted).toBe(false);
      expect(outcome.text).toContain('Hello from the fake model.');
      expect(events.some((event) => event.type === 'text-delta')).toBe(true);
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it.effect('reports every model call with its usage and tool calls', () =>
    Effect.gen(function* () {
      const events: Array<AgentLoopEvent> = [];
      const lookup = defineAgentTool({
        name: 'lookup',
        description: 'Look something up',
        schema: z.object({ q: z.string() }),
        invoke: async () => ({ found: true }),
      });
      const chatModel = new ScriptedChatModel([
        new AIMessage<StandardMessageStructure>({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'lookup', args: { q: 'capital' } }],
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
            input_token_details: { cache_read: 30 },
          },
        }),
        new AIMessage<StandardMessageStructure>({
          content: 'Paris.',
          usage_metadata: {
            input_tokens: 200,
            output_tokens: 10,
            total_tokens: 210,
            output_token_details: { reasoning: 4 },
          },
        }),
      ]);
      const factory = yield* AgentLoopFactory;
      const loop = yield* factory.create({
        name: 'test-agent',
        model: { model: 'test:scripted', provider: 'test', modelId: 'scripted', config: { chatModel } },
        systemPrompt: 'You are a helpful assistant.',
        tools: [lookup],
      });
      const outcome = yield* loop.stream(
        { parts: [{ kind: 'text', text: 'What is the capital of France?' }] },
        { threadId: 'usage-thread', onEvent: (event) => void events.push(event) },
      );

      expect(outcome.text).toBe('Paris.');
      expect(events.filter((event) => event.type === 'model-call')).toEqual([
        {
          type: 'model-call',
          model: 'test:scripted',
          usage: { input: 100, cacheRead: 30, cacheWrite: 0, output: 40, reasoning: 0, total: 140 },
          toolCalls: 1,
          reasoningEstimated: false,
        },
        {
          type: 'model-call',
          model: 'test:scripted',
          usage: { input: 200, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 4, total: 210 },
          toolCalls: 0,
          reasoningEstimated: false,
        },
      ]);
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it.effect("does not count a nested agent's model calls as the caller's own", () =>
    Effect.gen(function* () {
      const host = yield* hostRunner<AgentLoopFactory>();
      const parentEvents: Array<AgentLoopEvent> = [];
      const childEvents: Array<AgentLoopEvent> = [];
      const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
      const delegate = defineAgentTool({
        name: 'delegate',
        description: 'Ask a specialist',
        schema: z.object({ question: z.string() }),
        invoke: async () =>
          host.runPromise(
            Effect.gen(function* () {
              const factory = yield* AgentLoopFactory;
              const child = yield* factory.create({
                name: 'child-agent',
                model: {
                  model: 'test:child',
                  provider: 'test',
                  modelId: 'child',
                  config: {
                    chatModel: new ScriptedChatModel([
                      new AIMessage<StandardMessageStructure>({ content: 'Paris.', usage_metadata: usage }),
                    ]),
                  },
                },
                systemPrompt: 'You are a specialist.',
                tools: [],
              });
              const outcome = yield* child.stream(
                { parts: [{ kind: 'text', text: 'capital?' }] },
                { threadId: 'child-thread', onEvent: (event) => void childEvents.push(event) },
              );
              return outcome.text;
            }),
          ),
      });
      const factory = yield* AgentLoopFactory;
      const parent = yield* factory.create({
        name: 'parent-agent',
        model: {
          model: 'test:parent',
          provider: 'test',
          modelId: 'parent',
          config: {
            chatModel: new ScriptedChatModel([
              new AIMessage<StandardMessageStructure>({
                content: '',
                tool_calls: [{ id: 'call-1', name: 'delegate', args: { question: 'capital?' } }],
                usage_metadata: usage,
              }),
              new AIMessage<StandardMessageStructure>({ content: 'The specialist says Paris.', usage_metadata: usage }),
            ]),
          },
        },
        systemPrompt: 'You delegate.',
        tools: [delegate],
      });
      yield* parent.stream(
        { parts: [{ kind: 'text', text: 'What is the capital of France?' }] },
        { threadId: 'parent-thread', onEvent: (event) => void parentEvents.push(event) },
      );

      const models = (events: ReadonlyArray<AgentLoopEvent>) =>
        events.flatMap((event) => (event.type === 'model-call' ? [event.model] : []));
      expect(models(parentEvents)).toEqual(['test:parent', 'test:parent']);
      expect(models(childEvents)).toEqual(['test:child']);
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it('estimates thinking a provider bills inside output without counting it', () => {
    const tokens = { input: 50, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0, total: 150 };
    expect(withReasoningEstimate(tokens, 80, true)).toEqual({ tokens: { ...tokens, reasoning: 80 }, estimated: true });
    expect(withReasoningEstimate(tokens, 80, false)).toEqual({ tokens, estimated: false });
    const counted = { ...tokens, reasoning: 30 };
    expect(withReasoningEstimate(counted, 80, true)).toEqual({ tokens: counted, estimated: false });
  });

  it.effect('isolates a child agent stream from an enclosing LangGraph stream', () =>
    Effect.gen(function* () {
      const host = yield* hostRunner<AgentLoopFactory>();
      const ParentState = Annotation.Root({ outcome: Annotation<string>() });
      const graph = new StateGraph(ParentState)
        .addNode('agent', async () => {
          const outcome = await host.runPromise(
            Effect.gen(function* () {
              const factory = yield* AgentLoopFactory;
              const loop = yield* factory.create({
                name: 'nested-agent',
                model: {
                  model: 'test:fake',
                  provider: 'test',
                  modelId: 'fake',
                  config: { chatModel: new FakeListChatModel({ responses: ['Nested response.'] }) },
                },
                systemPrompt: 'You are a helpful assistant.',
                tools: [],
              });
              return yield* loop.stream(
                { parts: [{ kind: 'text', text: 'hi' }] },
                { threadId: 'nested-thread', onEvent: () => {} },
              );
            }),
          );
          return { outcome: outcome.text };
        })
        .addEdge('__start__', 'agent')
        .compile();

      const result = yield* Effect.promise(() => graph.invoke({ outcome: '' }));

      expect(result.outcome).toContain('Nested response.');
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it('checkpoints input-required tool output and invokes its continuation after resume', async () => {
    const State = Annotation.Root({ result: Annotation<unknown>() });
    const resumedInputs: Array<unknown> = [];
    const resumeTool = defineAgentTool({
      name: 'resume',
      description: 'Resume execution',
      schema: z.object({ executionId: z.string(), action: z.enum(['accept', 'decline', 'cancel']) }),
      invoke: async (input) => {
        resumedInputs.push(input);
        return { status: 'completed', value: 'done' };
      },
    });
    const graph = new StateGraph(State)
      .addNode('tool', async () => ({
        result: await resumableToolOutput([resumeTool], {
          status: 'input-required',
          request: {
            type: 'mcp-elicitation',
            message: 'Approve?',
            resume: { toolName: 'resume', input: { executionId: 'execution-1' } },
          },
        }),
      }))
      .addEdge('__start__', 'tool')
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'elicitation-thread' }, durability: 'sync' as const };

    const paused = await graph.invoke({ result: null }, config);
    expect(paused).toHaveProperty('__interrupt__');
    expect(resumedInputs).toEqual([]);

    const completed = await graph.invoke(new Command({ resume: { action: 'accept' } }), config);
    expect(completed.result).toEqual({ status: 'completed', value: 'done' });
    expect(resumedInputs).toEqual([{ executionId: 'execution-1', action: 'accept' }]);
  });
});
