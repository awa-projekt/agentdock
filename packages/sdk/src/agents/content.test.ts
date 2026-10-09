import { describe, expect, it } from '@effect/vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type StandardMessageStructure,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatOpenAI } from '@langchain/openai';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { z } from 'zod';
import type { JsonSerializable } from '../schemas/json';
import { defineAgentTool, ToolRunFailure } from '../tools';
import {
  contentBlocksOf,
  decorateChatModel,
  messageParts,
  providerMessages,
  renderContentParts,
  toolOutputContent,
  userMessage,
} from './content';
import { AgentLoopFactoryLive } from './langgraph-loop';
import { AgentLoopFactory } from './loop';

const PNG = 'iVBORw0KGgo=';

const mcpImageResult = [
  { type: 'text', text: 'File 12: photo.png' },
  { type: 'image', data: PNG, mimeType: 'image/png' },
];

/** A tool call and its result with an image, as they sit in the agent's state. */
const toolTurn = (): ReadonlyArray<BaseMessage> => [
  new HumanMessage('Check the photo.'),
  new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'product_images', args: { product_id: '42' } }] }),
  new ToolMessage({
    tool_call_id: 'call-1',
    name: 'product_images',
    // SAFETY: LangChain standard content blocks, as `toolOutputContent` leaves them.
    content: toolOutputContent(mcpImageResult) as ToolMessage['content'],
  }),
];

describe('content blocks', () => {
  it('reads MCP content: text, images, embedded and linked resources', () => {
    const blocks = contentBlocksOf([
      { type: 'text', text: 'hello' },
      { type: 'image', data: PNG, mimeType: 'image/png', annotations: { audience: ['user'] } },
      { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'a note' } },
      { type: 'resource', resource: { uri: 'file:///scan.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' } },
      { type: 'resource_link', uri: 'https://example.test/sheet', name: 'sheet', mimeType: 'text/html' },
    ]);
    expect(blocks).toEqual(
      Option.some([
        { type: 'text', text: 'hello' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'text', text: 'Resource file:///notes.txt (text/plain):\na note' },
        { type: 'file', data: 'JVBERi0=', mimeType: 'application/pdf', metadata: { filename: 'scan.pdf' } },
        { type: 'text', text: 'Linked resource sheet <https://example.test/sheet> (text/html)' },
      ]),
    );
  });

  it('leaves a value that is not a list of content blocks alone', () => {
    expect(contentBlocksOf({ result: [] })).toEqual(Option.none());
    expect(contentBlocksOf([{ type: 'text', text: 'a' }, { type: 'unknown' }])).toEqual(Option.none());
    expect(toolOutputContent({ hits: 2 })).toEqual({ hits: 2 });
  });

  it('keeps media as standard blocks and joins text-only results', () => {
    expect(toolOutputContent(mcpImageResult)).toEqual(mcpImageResult);
    expect(
      toolOutputContent([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\n\ntwo');
  });

  it('builds the user turn from text, file and data parts', () => {
    expect(userMessage([{ kind: 'text', text: 'hi' }]).content).toBe('hi');
    expect(
      userMessage([
        { kind: 'text', text: 'Read this.' },
        { kind: 'file', file: { bytes: PNG, mimeType: 'image/png', name: 'photo.png' } },
        { kind: 'file', file: { uri: 'https://example.test/spec.pdf', mimeType: 'application/pdf' } },
        { kind: 'data', data: { product: '42' } },
      ]).content,
    ).toEqual([
      { type: 'text', text: 'Read this.' },
      { type: 'image', data: PNG, mimeType: 'image/png', metadata: { filename: 'photo.png' } },
      { type: 'file', url: 'https://example.test/spec.pdf', mimeType: 'application/pdf' },
      { type: 'text', text: '{\n  "product": "42"\n}' },
    ]);
  });

  it('records a message with media as text and file parts', () => {
    const message = new HumanMessage({
      content: [
        { type: 'text', text: 'Look:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    });
    expect(messageParts(message)).toEqual([
      { kind: 'text', text: 'Look:' },
      { kind: 'file', file: { bytes: PNG, mimeType: 'image/png' } },
    ]);
  });
});

describe('providerMessages', () => {
  it('puts images into Responses API tool results', () => {
    const [, , tool] = providerMessages(toolTurn(), 'openai-responses').slice(0);
    expect(tool?.content).toEqual([
      { type: 'input_text', text: 'File 12: photo.png' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' },
    ]);
  });

  it('moves images out of Chat Completions tool results into a user message right after', () => {
    const messages = providerMessages(toolTurn(), 'openai-chat');
    expect(messages).toHaveLength(4);
    expect(messages[2]?.content).toBe(
      'File 12: photo.png\n\n[image (image/png, 0 KB): attachment 1, shown in the next message]',
    );
    expect(messages[3]?.type).toBe('human');
    expect(messages[3]?.content).toEqual([
      { type: 'text', text: 'The tool results above returned these attachments:' },
      { type: 'text', text: 'Attachment 1 from product_images: image (image/png, 0 KB)' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
  });

  it('tells the model what a provider cannot take instead of dropping it', () => {
    const audio = new HumanMessage({
      content: [
        { type: 'text', text: 'Transcribe.' },
        { type: 'audio', data: 'UklGRg==', mimeType: 'audio/ogg' },
      ],
    });
    expect(providerMessages([audio], 'anthropic')[0]?.content).toEqual([
      { type: 'text', text: 'Transcribe.' },
      { type: 'text', text: '[audio (audio/ogg, 0 KB) not shown: the anthropic API takes no audio here]' },
    ]);
  });

  it('decodes text files for every provider', () => {
    const csv = new HumanMessage({
      content: [{ type: 'file', data: btoa('a,b\n1,2'), mimeType: 'text/csv', metadata: { filename: 'x.csv' } }],
    });
    expect(providerMessages([csv], 'mistral')[0]?.content).toEqual([
      { type: 'text', text: 'x.csv (text/csv):\na,b\n1,2' },
    ]);
  });

  it('leaves messages without media unchanged', () => {
    const plain = [new HumanMessage('hi'), new AIMessage('hello')];
    expect(providerMessages(plain, 'openai-chat')).toEqual(plain);
  });
});

/** Captures the body a provider SDK would send, then fails the request so nothing leaves the process. */
const recordingFetch = () => {
  const bodies: Array<unknown> = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: { message: 'recorded' } }), { status: 400 });
  };
  return { bodies, fetch };
};

describe('what providers receive', () => {
  it('OpenAI Responses API: the image inside the function call output', async () => {
    const { bodies, fetch } = recordingFetch();
    const model = new ChatOpenAI({
      model: 'gpt-test',
      apiKey: 'test',
      useResponsesApi: true,
      maxRetries: 0,
      configuration: { fetch },
    });
    await model.invoke(providerMessages(toolTurn(), 'openai-responses')).catch(() => undefined);
    expect(bodies[0]).toMatchObject({
      input: expect.arrayContaining([
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: [
            { type: 'input_text', text: 'File 12: photo.png' },
            { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' },
          ],
        },
      ]),
    });
  });

  it('OpenAI Chat Completions: a text tool result, then the image from the user', async () => {
    const { bodies, fetch } = recordingFetch();
    const model = new ChatOpenAI({ model: 'gpt-test', apiKey: 'test', maxRetries: 0, configuration: { fetch } });
    await model.invoke(providerMessages(toolTurn(), 'openai-chat')).catch(() => undefined);
    expect(bodies[0]).toMatchObject({
      messages: [
        { role: 'user', content: 'Check the photo.' },
        { role: 'assistant' },
        { role: 'tool', tool_call_id: 'call-1', content: expect.stringContaining('attachment 1') },
        {
          role: 'user',
          content: expect.arrayContaining([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]),
        },
      ],
    });
  });

  it('Anthropic: the image inside the tool result', async () => {
    const { bodies, fetch } = recordingFetch();
    const model = new ChatAnthropic({ model: 'claude-test', apiKey: 'test', maxRetries: 0, clientOptions: { fetch } });
    await model.invoke(providerMessages(toolTurn(), 'anthropic')).catch(() => undefined);
    expect(bodies[0]).toMatchObject({
      messages: expect.arrayContaining([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [
                { type: 'text', text: 'File 12: photo.png' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
              ],
            },
          ],
        },
      ]),
    });
  });
});

describe('decorateChatModel', () => {
  class StartSpy extends BaseCallbackHandler {
    name = 'start-spy';
    starts = 0;
    override async handleChatModelStart(): Promise<void> {
      this.starts += 1;
    }
  }

  it('keeps rendering parts and reporting calls when structured output copies the model', async () => {
    const { bodies, fetch } = recordingFetch();
    const spy = new StartSpy();
    const model = decorateChatModel(
      new ChatOpenAI({
        model: 'gpt-test',
        apiKey: 'test',
        useResponsesApi: true,
        maxRetries: 0,
        configuration: { fetch },
      }),
      (current) => {
        renderContentParts(current, 'openai-responses');
        current.callbacks = [spy];
      },
    );

    const structured = model.withStructuredOutput(z.object({ ok: z.boolean() }), {
      name: 'Check',
      method: 'jsonSchema',
    });
    await structured.invoke([...toolTurn()]).catch(() => undefined);

    expect(spy.starts).toBe(1);
    expect(bodies[0]).toMatchObject({
      input: expect.arrayContaining([
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: expect.arrayContaining([
            { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' },
          ]),
        },
      ]),
    });
  });
});

/** Answers each call with the next scripted message and keeps what every call was sent. */
class RecordingChatModel extends BaseChatModel {
  readonly received: Array<ReadonlyArray<BaseMessage>> = [];
  private calls = 0;

  constructor(private readonly script: ReadonlyArray<AIMessage<StandardMessageStructure>>) {
    super({});
  }

  _llmType(): string {
    return 'recording';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: Array<BaseMessage>): Promise<ChatResult> {
    this.received.push(messages);
    const message = this.script[Math.min(this.calls, this.script.length - 1)] ?? new AIMessage('');
    this.calls += 1;
    return { generations: [{ text: '', message }] };
  }
}

const imageTool = (invoke: () => Promise<JsonSerializable>) =>
  defineAgentTool({ name: 'product_images', description: 'The product images.', schema: z.object({}), invoke });

const callingTheTool = () => [
  new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'product_images', args: {} }] }),
  new AIMessage('done'),
];

describe('the agent loop', () => {
  it.effect('shows a tool image to the model in its provider format', () =>
    Effect.gen(function* () {
      const chatModel = new RecordingChatModel(callingTheTool());
      const factory = yield* AgentLoopFactory;
      const loop = yield* factory.create({
        name: 'images',
        model: { model: 'groq:test', provider: 'groq', modelId: 'test', config: { chatModel } },
        systemPrompt: 'Check images.',
        tools: [imageTool(async () => mcpImageResult)],
      });

      yield* loop.stream(
        { parts: [{ kind: 'text', text: 'Check product 42.' }] },
        { threadId: 't', onEvent: () => {} },
      );

      const second = chatModel.received[1] ?? [];
      expect(second.at(-1)?.type).toBe('human');
      expect(second.at(-1)?.content).toEqual(
        expect.arrayContaining([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]),
      );
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it.effect('ends the run when a tool fails the run', () =>
    Effect.gen(function* () {
      const factory = yield* AgentLoopFactory;
      const loop = yield* factory.create({
        name: 'research',
        model: {
          model: 'test:fake',
          provider: 'test',
          modelId: 'fake',
          config: { chatModel: new RecordingChatModel(callingTheTool()) },
        },
        systemPrompt: 'Research.',
        tools: [
          imageTool(async () => {
            throw new ToolRunFailure({ message: 'catalog could not be reached' });
          }),
        ],
      });

      const exit = yield* Effect.exit(
        loop.stream({ parts: [{ kind: 'text', text: 'Go.' }] }, { threadId: 't', onEvent: () => {} }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain('catalog could not be reached');
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );

  it.effect('answers any other tool error to the model', () =>
    Effect.gen(function* () {
      const chatModel = new RecordingChatModel(callingTheTool());
      const factory = yield* AgentLoopFactory;
      const loop = yield* factory.create({
        name: 'research',
        model: { model: 'test:fake', provider: 'test', modelId: 'fake', config: { chatModel } },
        systemPrompt: 'Research.',
        tools: [
          imageTool(async () => {
            throw new Error('unknown product');
          }),
        ],
      });

      const outcome = yield* loop.stream(
        { parts: [{ kind: 'text', text: 'Go.' }] },
        { threadId: 't', onEvent: () => {} },
      );

      expect(outcome.text).toBe('done');
      expect(chatModel.received[1]?.at(-1)?.content).toContain('unknown product');
    }).pipe(Effect.provide(AgentLoopFactoryLive)),
  );
});
