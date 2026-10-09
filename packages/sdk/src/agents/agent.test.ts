import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { interrupt } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgentTool } from '../tools';
import { Agent, MemoryRunStore } from './agent';
import type { AgentLoopEvent } from './loop';

/**
 * A tool-calling fake: returns the scripted `AIMessage`s in order, advancing
 * one per model call. `FakeListChatModel` can't emit tool calls and
 * `FakeStreamingChatModel` always replays its first response, so neither can
 * script a call-tool-then-answer sequence.
 */
class ScriptedChatModel extends BaseChatModel {
  private i = 0;

  constructor(
    private readonly script: ReadonlyArray<AIMessage>,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.i, this.script.length - 1)];
    if (!message) throw new Error('ScriptedChatModel: empty script');
    this.i++;
    return {
      generations: [{ text: message.text, message }],
    };
  }
}

describe('Agent', () => {
  it('prompts with a direct model/tools and reports events via subscribe', async () => {
    const model = new FakeListChatModel({ responses: ['Hello from the fake model.'] });
    const events: Array<AgentLoopEvent> = [];

    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
    });
    session.subscribe((event) => void events.push(event));

    const result = await session.prompt('hi');

    expect(result.status).toBe('completed');
    expect(result.text).toContain('Hello from the fake model.');
    expect(events.some((event) => event.type === 'text-delta')).toBe(true);
  });

  it('continues the same conversation across prompt() calls', async () => {
    const model = new FakeListChatModel({ responses: ['first reply', 'second reply'] });
    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
    });

    const first = await session.prompt('one');
    const second = await session.prompt('two');

    expect(second.taskId).toBe(first.taskId);
    expect(second.contextId).toBe(first.contextId);
    expect(session.state.history.length).toBeGreaterThan(2);
  });

  it('resolves the model and tools lazily via resolveModel/resolveTools', async () => {
    const model = new FakeListChatModel({ responses: ['resolved reply'] });
    let resolveModelCalls = 0;
    let resolveToolsCalls = 0;

    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: async ({ provider, model: requestedModel }) => {
        resolveModelCalls++;
        expect(provider).toBe('fake');
        expect(requestedModel).toBe('test-model');
        return { chatModel: model };
      },
      resolveTools: async ({ agent }) => {
        resolveToolsCalls++;
        expect(agent.id).toBe('test-agent');
        return [];
      },
    });

    const result = await session.prompt('hi');

    expect(result.text).toContain('resolved reply');
    expect(resolveModelCalls).toBe(1);
    expect(resolveToolsCalls).toBe(1);
  });

  it('persists run records through a custom runStore', async () => {
    const model = new FakeListChatModel({ responses: ['stored reply'] });
    const saved: Array<{ readonly id: string; readonly status: string }> = [];
    const store = new MemoryRunStore();
    const trackingStore = {
      save: async (record: Parameters<MemoryRunStore['save']>[0]) => {
        saved.push({ id: record.id, status: record.status.state });
        await store.save(record);
      },
      get: (id: string) => store.get(id),
    };

    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
      runStore: trackingStore,
    });

    await session.prompt('hi');

    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)?.status).toBe('completed');
  });

  it('reset() clears conversation continuity so the next prompt starts fresh', async () => {
    const model = new FakeListChatModel({ responses: ['first', 'second'] });
    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
    });

    const first = await session.prompt('one');
    session.reset();
    const second = await session.prompt('two');

    expect(second.taskId).not.toBe(first.taskId);
    expect(session.state.history.length).toBe(2);
  });

  it('restore() reattaches to an existing session primed from its run store', async () => {
    const model = new FakeListChatModel({ responses: ['reply'] });
    const store = new MemoryRunStore();
    const session = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
      runStore: store,
    });
    const result = await session.prompt('hi');

    const restored = await Agent.restore({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
      runStore: store,
      contextId: result.contextId,
      taskId: result.taskId,
    });

    expect(restored.state.taskId).toBe(result.taskId);
    expect(restored.state.history.length).toBe(result.record.history.length);
  });

  it('pauses input-required on a tool interrupt and resume() continues the run', async () => {
    const askHuman = defineAgentTool({
      name: 'ask_human',
      description: 'Ask the human a question and wait for their answer.',
      schema: z.object({ question: z.string() }),
      invoke: ({ question }) => {
        const answer = interrupt({ question });
        return Promise.resolve(`The human answered: ${JSON.stringify(answer)}`);
      },
    });

    const model = new ScriptedChatModel([
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'ask_human', args: { question: 'Which city?' } }],
      }),
      new AIMessage({ content: 'Thanks, resuming with your answer.' }),
    ]);

    const agent = new Agent({
      id: 'hitl-agent',
      name: 'HITL Agent',
      instructions: 'Ask the human when unsure.',
      modelId: 'fake:scripted',
      resolveModel: () => ({ chatModel: model }),
      tools: [askHuman],
    });

    const paused = await agent.prompt('Where should we go?');
    expect(paused.status).toBe('input-required');
    expect(agent.state.status).toBe('input-required');
    expect(agent.state.inputRequired).toBeDefined();

    const events: Array<AgentLoopEvent> = [];
    agent.subscribe((event) => void events.push(event));

    const resumed = await agent.resume('Lisbon');
    expect(resumed.status).toBe('completed');
    expect(resumed.text).toContain('Thanks, resuming');
    expect(resumed.taskId).toBe(paused.taskId);

    const toolResult = events.find((event) => event.type === 'tool-result');
    expect(toolResult && 'output' in toolResult ? String(toolResult.output) : '').toContain('Lisbon');
  });

  it('resume() throws unless the last turn paused input-required', async () => {
    const model = new FakeListChatModel({ responses: ['done'] });
    const agent = new Agent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'You are a helpful assistant.',
      modelId: 'fake:test-model',
      resolveModel: () => ({ chatModel: model }),
      tools: [],
    });

    await expect(agent.resume('answer')).rejects.toThrow(/only valid while a turn is paused/);
    await agent.prompt('hi');
    await expect(agent.resume('answer')).rejects.toThrow(/only valid while a turn is paused/);
  });
});
