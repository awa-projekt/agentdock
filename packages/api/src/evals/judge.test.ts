import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { describe, expect, it } from '@effect/vitest';
import { type Json, jsonProperty, jsonString, type Model } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { ModelCatalog } from '../models/catalog';
import { ProviderKeyRegistry } from '../providers/service';
import { EvalJudge, EvalJudgeLive } from './judge';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * A stand-in for an OpenAI-compatible provider, so the live judge runs its
 * real LangChain path without a network call or a token spent. It answers a
 * structured-output request with `verdict`, via a tool call when the client
 * asked for one and as JSON content otherwise.
 */
const fakeProvider = (verdict: string, requests: Array<Json>) =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const payload = yield* request.json;
        requests.push(payload);
        const answer = encodeJson({ reasoning: 'The answer names Paris.', verdict });
        const usesTools = jsonProperty(payload, 'tools') !== undefined;
        const message = usesTools
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_verdict', arguments: answer } }],
            }
          : { role: 'assistant', content: answer };
        return HttpServerResponse.jsonUnsafe({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'fake-judge',
          choices: [{ index: 0, message, finish_reason: usesTools ? 'tool_calls' : 'stop' }],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 200,
            total_tokens: 1_200,
            prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 50 },
          },
        });
      }).pipe(Effect.orDie),
    );
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === 'UnixPathAddress') return yield* Effect.die('expected a TCP test server');
    return address.port;
  });

const judgeLayer = (port: number) =>
  EvalJudgeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ProviderKeyRegistry,
          ProviderKeyRegistry.of({
            list: () => Effect.succeed([]),
            set: () => Effect.die('unused'),
            remove: () => Effect.succeed(false),
            listCustom: () => Effect.succeed([]),
            getRuntimeConfig: () =>
              Effect.succeed({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}/v1`, kind: 'openai-compatible' }),
          }),
        ),
        Layer.succeed(
          ModelCatalog,
          ModelCatalog.of({
            list: Effect.succeed([]),
            find: (value): Effect.Effect<Model> =>
              Effect.succeed({
                value,
                provider: 'fake',
                providerName: 'Fake',
                id: 'fake-judge',
                name: 'Fake judge',
                inputCostPerMillion: 1,
                outputCostPerMillion: 10,
                cacheReadCostPerMillion: 0.1,
                cacheWriteCostPerMillion: 1.25,
              }),
          }),
        ),
      ),
    ),
  );

const request = {
  model: 'fake:fake-judge',
  system: 'You are an impartial evaluator.',
  prompt: 'Is "Paris" the capital of France?',
  verdicts: ['PASS', 'FAIL', 'UNKNOWN'],
};

describe('EvalJudgeLive', () => {
  it.live('asks for a structured verdict and prices the call from the catalog', () =>
    Effect.gen(function* () {
      const requests: Array<Json> = [];
      const port = yield* fakeProvider('PASS', requests);
      const verdict = yield* EvalJudge.use((judge) => judge.judge(request)).pipe(Effect.provide(judgeLayer(port)));

      expect(verdict.verdict).toBe('PASS');
      expect(verdict.reasoning).toBe('The answer names Paris.');
      expect(verdict.usage?.tokens).toEqual({
        input: 1_000,
        cacheRead: 400,
        cacheWrite: 100,
        output: 200,
        reasoning: 50,
        total: 1_200,
      });
      // Uncached input at $1/M, cache reads at $0.1/M, cache writes at $1.25/M, output at $10/M.
      const cost = verdict.usage?.cost;
      expect(cost?.input).toBeCloseTo(500 / 1_000_000);
      expect(cost?.cacheRead).toBeCloseTo((400 * 0.1) / 1_000_000);
      expect(cost?.cacheWrite).toBeCloseTo((100 * 1.25) / 1_000_000);
      expect(cost?.output).toBeCloseTo((200 * 10) / 1_000_000);
      expect(cost?.reasoning).toBeCloseTo((50 * 10) / 1_000_000);
      expect(cost?.total).toBeCloseTo((500 + 40 + 125 + 2_000) / 1_000_000);
      expect(verdict.usage).toMatchObject({ calls: 1, reasoningEstimated: false });

      const sent = encodeJson(requests[0] ?? null);
      expect(jsonString(requests[0], 'model')).toBe('fake-judge');
      expect(sent).toContain('You are an impartial evaluator.');
      expect(sent).toContain('"enum":["PASS","FAIL","UNKNOWN"]');
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.live('rejects a verdict outside the allowed set', () =>
    Effect.gen(function* () {
      const port = yield* fakeProvider('MAYBE', []);
      const error = yield* EvalJudge.use((judge) => judge.judge(request)).pipe(
        Effect.provide(judgeLayer(port)),
        Effect.flip,
      );
      expect(error.message).toContain("answered 'MAYBE'");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
});
