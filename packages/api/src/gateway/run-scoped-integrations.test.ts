import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { describe, expect, it } from '@effect/vitest';
import { ConnectionName, IntegrationSlug, ToolAddress } from '@integragents/contracts';
import { McpClient, McpError, type Tool } from '@integragents/host';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Json } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import {
  IntegrationCallScope,
  mcpToolResult,
  openIntegrationCallScope,
  runScopedIntegrations,
  transportFailure,
} from './run-scoped-integrations';

/** One stateless MCP server on a free port; `calls` records each tool call and the Authorization it came with. */
const serveMcp = (answer: (tool: string) => CallToolResult) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly tool: string; readonly authorization: string | undefined }> = [];
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(async () => {
          const server = new Server({ name: 'catalog', version: '1.0.0' }, { capabilities: { tools: {} } });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: 'search_products', inputSchema: { type: 'object' } }],
          }));
          server.setRequestHandler(CallToolRequestSchema, async (call) => {
            calls.push({ tool: call.params.name, authorization });
            return answer(call.params.name);
          });
          const transport = new WebStandardStreamableHTTPServerTransport();
          await server.connect(transport);
          return transport.handleRequest(web);
        });
        return HttpServerResponse.fromWeb(response);
      }).pipe(Effect.orDie),
    );
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === 'UnixPathAddress') return yield* Effect.die('expected a TCP test server');
    return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
  });

const address = ToolAddress.make('tools.catalog.org.default.search_products');

const toolRecord = (readOnly: boolean): Tool => ({
  address,
  owner: 'org',
  integration: IntegrationSlug.make('catalog'),
  connection: ConnectionName.make('default'),
  name: 'search_products',
  description: 'Finds similar products.',
  readOnly,
  call: { kind: 'mcp', tool: 'search_products' },
  capturedAt: 0,
});

const store = (readOnly: boolean) => ({ findTool: () => Effect.succeed(Option.some(toolRecord(readOnly))) });

/** A host whose registered endpoint answers with `execute`. */
const host = (answer: () => Effect.Effect<Json, McpError>) => ({
  execute: (_address: ToolAddress, _input: Json) => answer(),
});

const refused = new McpError({
  endpoint: 'http://127.0.0.1:20000/mcp',
  detail: 'fetch failed',
  cause: Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  }),
});

const droppedDuringCall = new McpError({
  endpoint: 'http://127.0.0.1:20000/mcp',
  detail: 'tools/call search_products failed: fetch failed',
  cause: Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  }),
});

const answeredWithError = new McpError({
  endpoint: 'http://127.0.0.1:20000/mcp',
  detail: 'tools/call search_products failed: Invalid params',
  cause: Object.assign(new Error('Invalid params'), { code: -32602 }),
});

const mcpLayer = McpClient.layer.pipe(Layer.provide(FetchHttpClient.layer));

describe('transportFailure', () => {
  it('tells a call that never left from one that may have arrived, and both from a server error', () => {
    expect(transportFailure(refused)).toBe('not-sent');
    expect(transportFailure(droppedDuringCall)).toBe('interrupted');
    expect(transportFailure(answeredWithError)).toBeUndefined();
  });

  it('counts a gateway that answers 503 as unreachable', () => {
    const unavailable = new McpError({
      endpoint: 'http://127.0.0.1:20000/mcp',
      detail: 'tools/call search_products failed: Error POSTing to endpoint',
      cause: { code: 'CLIENT_HTTP_NOT_IMPLEMENTED', data: { status: 503 } },
    });
    expect(transportFailure(unavailable)).toBe('interrupted');
  });
});

describe('mcpToolResult', () => {
  it.effect('keeps images next to structured content', () =>
    Effect.gen(function* () {
      const content = [
        { type: 'text', text: 'Caption of product 42' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ];
      expect(yield* mcpToolResult('product_images', { content, structuredContent: { count: 1 } })).toEqual([
        ...content,
        { type: 'text', text: '{"count":1}' },
      ]);
      const mirrored = [...content, { type: 'text', text: '{"count": 1}' }];
      expect(yield* mcpToolResult('product_images', { content: mirrored, structuredContent: { count: 1 } })).toEqual(
        mirrored,
      );
    }),
  );

  it.effect('answers a single text block with its JSON, and structured content when there is no media', () =>
    Effect.gen(function* () {
      expect(yield* mcpToolResult('search', { content: [{ type: 'text', text: '[{"id":"1"}]' }] })).toEqual([
        { id: '1' },
      ]);
      expect(
        yield* mcpToolResult('search', {
          content: [{ type: 'text', text: '{"result":[]}' }],
          structuredContent: { result: [] },
        }),
      ).toEqual({ result: [] });
    }),
  );

  it.effect('fails with the text of an error result', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        mcpToolResult('search', { isError: true, content: [{ type: 'text', text: 'unknown product' }] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? String(exit.cause) : '').toContain('unknown product');
    }),
  );
});

describe('runScopedIntegrations', () => {
  it.live("calls the run's endpoint for an overridden integration, with its token instead of the stored one", () =>
    Effect.gen(function* () {
      const server = yield* serveMcp(() => ({
        content: [
          { type: 'text', text: 'served by the case server' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
        structuredContent: { hits: 1 },
      }));
      const mcp = yield* McpClient;
      const integrations = runScopedIntegrations({
        host: host(() => Effect.die('the registered endpoint must not be called')),
        store: store(true),
        mcp,
      });
      const scope = yield* openIntegrationCallScope({
        catalog: { endpoint: server.url, bearerToken: 'case-token' },
      });

      const result = yield* integrations
        .execute(address, { product_id: '42' })
        .pipe(Effect.provideService(IntegrationCallScope, scope));

      expect(result).toEqual([
        { type: 'text', text: 'served by the case server' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text', text: '{"hits":1}' },
      ]);
      expect(server.calls).toEqual([{ tool: 'search_products', authorization: 'Bearer case-token' }]);
    }).pipe(Effect.provide(mcpLayer), Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.live('retries a server that refuses the connection, then gives the answer', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const integrations = runScopedIntegrations({
        host: host(() => {
          attempts += 1;
          return attempts < 3 ? Effect.fail(refused) : Effect.succeed({ hits: 3 });
        }),
        store: store(false),
        mcp: yield* McpClient,
        retryDelay: '1 millis',
      });

      const result = yield* integrations.execute(address, {});

      expect(result).toEqual({ hits: 3 });
      expect(attempts).toBe(3);
    }).pipe(Effect.provide(mcpLayer)),
  );

  it.live('reports a server still unreachable after its retries', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const integrations = runScopedIntegrations({
        host: host(() => {
          attempts += 1;
          return Effect.fail(refused);
        }),
        store: store(false),
        mcp: yield* McpClient,
        retries: 2,
        retryDelay: '1 millis',
      });
      const scope = yield* openIntegrationCallScope(undefined);

      const exit = yield* Effect.exit(
        integrations.execute(address, {}).pipe(Effect.provideService(IntegrationCallScope, scope)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toBe(3);
      expect(yield* Ref.get(scope.unreachable)).toEqual(
        Option.some({ integration: 'catalog', endpoint: refused.endpoint, detail: refused.detail }),
      );
    }).pipe(Effect.provide(mcpLayer)),
  );

  it.live('does not repeat a call that may have arrived unless the tool only reads', () =>
    Effect.gen(function* () {
      const attemptsFor = (readOnly: boolean) =>
        Effect.gen(function* () {
          let attempts = 0;
          const integrations = runScopedIntegrations({
            host: host(() => {
              attempts += 1;
              return Effect.fail(droppedDuringCall);
            }),
            store: store(readOnly),
            mcp: yield* McpClient,
            retries: 2,
            retryDelay: '1 millis',
          });
          yield* Effect.exit(integrations.execute(address, {}));
          return attempts;
        });

      expect(yield* attemptsFor(false)).toBe(1);
      expect(yield* attemptsFor(true)).toBe(3);
    }).pipe(Effect.provide(mcpLayer)),
  );

  it.live('neither retries nor reports an error the server answered with', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const integrations = runScopedIntegrations({
        host: host(() => {
          attempts += 1;
          return Effect.fail(answeredWithError);
        }),
        store: store(true),
        mcp: yield* McpClient,
        retryDelay: '1 millis',
      });
      const scope = yield* openIntegrationCallScope(undefined);

      yield* Effect.exit(integrations.execute(address, {}).pipe(Effect.provideService(IntegrationCallScope, scope)));

      expect(attempts).toBe(1);
      expect(yield* Ref.get(scope.unreachable)).toEqual(Option.none());
    }).pipe(Effect.provide(mcpLayer)),
  );
});
