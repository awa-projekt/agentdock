import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { TestClock } from 'effect/testing';
import { buildCatalog, ModelCatalog, ModelCatalogLive } from './catalog';

const catalog = {
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5 (latest)',
        tool_call: true,
        reasoning: true,
        release_date: '2026-01-02',
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.5 },
      },
      'gpt-5-chat-completions': {
        id: 'gpt-5-chat-completions',
        name: 'GPT-5 (latest)',
        tool_call: true,
        release_date: '2026-01-02',
      },
      'text-embedding-3': { id: 'text-embedding-3', name: 'Embedding', tool_call: false },
      broken: { id: 'broken', name: 'Broken', tool_call: true, limit: { context: 'a lot' } },
    },
  },
  google: { name: 'Google', models: { gemini: { id: 'gemini', name: 'Gemini', tool_call: true } } },
};

describe('buildCatalog', () => {
  it('maps a models.dev entry onto the model domain', () => {
    const model = buildCatalog(catalog).find((entry) => entry.value === 'openai:gpt-5');
    expect(model).toMatchObject({
      provider: 'openai',
      providerName: 'OpenAI',
      id: 'gpt-5',
      name: 'GPT-5',
      contextWindow: 400000,
      maxOutputTokens: 128000,
      inputCostPerMillion: 1.25,
      cacheWriteCostPerMillion: 1.5,
      reasoning: true,
      suggested: true,
    });
  });

  it('takes effort tiers from reasoning_options and offers none without them', () => {
    const models = buildCatalog({
      openai: {
        name: 'OpenAI',
        models: {
          published: {
            id: 'gpt-5.4',
            name: 'Published',
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'bogus'] }],
          },
          budget: {
            id: 'gpt-5.1',
            name: 'Budget only',
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
          },
          plain: { id: 'gpt-4.1', name: 'Plain', tool_call: true, reasoning: false },
        },
      },
    });
    const efforts = (id: string) => models.find((entry) => entry.id === id)?.reasoningEfforts;
    expect(efforts('gpt-5.4')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(efforts('gpt-5.1')).toBeUndefined();
    expect(efforts('gpt-4.1')).toBeUndefined();
  });

  it('keeps the shortest id when two entries normalize to the same name', () => {
    const openai = buildCatalog(catalog).filter((model) => model.provider === 'openai');
    expect(openai.map((model) => model.id)).toEqual(['gpt-5']);
  });

  it('skips entries without tool calling and entries that do not match the document shape', () => {
    const ids = buildCatalog(catalog).map((model) => model.id);
    expect(ids).not.toContain('text-embedding-3');
    expect(ids).not.toContain('broken');
  });

  it('renames the google provider onto the id used by the runtime', () => {
    expect(buildCatalog(catalog).map((model) => model.provider)).toContain('google_genai');
  });

  it('yields an empty catalog for a document that is not an object', () => {
    expect(buildCatalog('nope')).toEqual([]);
    expect(buildCatalog({ openai: 'nope' })).toEqual([]);
  });
});

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** models.dev answering after one second. */
const SlowModelsDev = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sleep('1 second').pipe(
      Effect.as(HttpClientResponse.fromWeb(request, new Response(encodeCatalog(catalog), { status: 200 }))),
    ),
  ),
);

describe('ModelCatalog', () => {
  it.effect('keeps serving the catalog after the caller that started the fetch is interrupted', () =>
    Effect.gen(function* () {
      const models = yield* ModelCatalog;
      const aborted = yield* Effect.forkChild(models.find('openai:gpt-5'));
      yield* TestClock.adjust('100 millis');
      yield* Effect.forkChild(Fiber.interrupt(aborted));
      const next = yield* Effect.forkChild(models.find('openai:gpt-5'));
      yield* TestClock.adjust('1 second');

      expect((yield* Fiber.join(next)).name).toBe('GPT-5');
    }).pipe(Effect.provide(ModelCatalogLive.pipe(Layer.provide(SlowModelsDev)))),
  );
});
