import { describe, expect, it } from '@effect/vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { Annotation, Command, interrupt, StateGraph } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { z } from 'zod';
import { defineAgentTool } from '../tools';
import { buildAgentGraph } from './compose';
import { ModelProvider } from './model-provider';
import { AgentToolResolver } from './tool-resolver';

class ApprovalModel extends BaseChatModel {
  calls = 0;
  _llmType() {
    return 'approval-test';
  }
  override bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    const message =
      messages.at(-1)?.type === 'tool'
        ? new AIMessage('Approved result')
        : new AIMessage({ content: '', tool_calls: [{ id: 'approval', name: 'approve', args: {} }] });
    return { generations: [{ text: String(message.content), message }] };
  }
}

const ParentState = Annotation.Root({ result: Annotation<string>() });

describe('native agent composition', () => {
  it.effect('propagates a child approval and resumes through a recreated parent graph', () =>
    Effect.gen(function* () {
      const model = new ApprovalModel({});
      const saver = new MemorySaver();
      let mutations = 0;
      const services = Layer.mergeAll(
        Layer.succeed(ModelProvider, {
          resolve: () =>
            Effect.succeed({
              model: 'test:approval',
              modelId: 'approval',
              provider: 'test',
              config: { chatModel: model },
            }),
        }),
        AgentToolResolver.static([
          defineAgentTool({
            name: 'approve',
            description: 'Approve the change.',
            schema: z.object({}),
            invoke: async () => {
              const approved = interrupt({ title: 'Approve?' });
              if (approved) mutations++;
              return 'done';
            },
          }),
        ]),
      );
      const buildChild = buildAgentGraph(
        { id: 'specialist', name: 'Specialist', instructions: 'Ask approval.', model: 'test:approval' },
        { taskId: 'task', contextId: 'thread', userMessageId: 'input' },
      ).pipe(Effect.provide(services));
      const build = (child: Effect.Success<typeof buildChild>) =>
        new StateGraph(ParentState)
          .addNode('specialist', async () => {
            const result = await child.invoke({ messages: [{ role: 'user', content: 'Make the change.' }] });
            return { result: String(result.messages.at(-1)?.content) };
          })
          .addEdge('__start__', 'specialist')
          .addEdge('specialist', '__end__')
          .compile({ checkpointer: saver });

      const config = { configurable: { thread_id: 'thread' }, durability: 'sync' as const };
      const first = build(yield* buildChild);
      const paused = yield* Effect.promise(() => first.invoke({ result: '' }, config));
      expect(paused).toHaveProperty('__interrupt__');
      expect(mutations).toBe(0);
      expect(model.calls).toBe(1);
      const second = build(yield* buildChild);
      const completed = yield* Effect.promise(() => second.invoke(new Command({ resume: true }), config));
      expect(completed.result).toBe('Approved result');
      expect(mutations).toBe(1);
      expect(model.calls).toBe(2);
    }),
  );
});
