import 'dotenv/config';

const [
  { NodeFileSystem, NodeRuntime },
  { CoreServices, bootstrapInternalAgentMcpSource },
  { ensureDatabaseTables },
  { Effect, Layer, Logger },
  { mkdirSync },
  { createServer },
  { Readable },
  { createServerHandlers, closeServerHandlers },
] = await Promise.all([
  import('@effect/platform-node'),
  import('../../../packages/api/index'),
  import('../../../packages/db/src/init.ts'),
  import('effect'),
  import('node:fs'),
  import('node:http'),
  import('node:stream'),
  import('./handlers'),
]);
const { ObservabilityLive } = await import('./observability');

const logFileName = `logs/api-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
mkdirSync('logs', { recursive: true });

const fileLogger = Logger.formatLogFmt.pipe(Logger.toFile(logFileName));
const LoggerLive = Logger.layer([fileLogger]).pipe(Layer.provide(NodeFileSystem.layer));
const RuntimeLive = Layer.mergeAll(LoggerLive, ObservabilityLive);

const toWebRequest = (req: import('node:http').IncomingMessage): Request => {
  const host = req.headers.host ?? '127.0.0.1:38123';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Request(url, { method: req.method, headers });
  }

  return new Request(url, {
    method: req.method,
    headers,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
};

const writeWebResponse = async (res: import('node:http').ServerResponse, response: Response) => {
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.writeHead(response.status, response.statusText);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as any).pipe(res).on('finish', resolve).on('error', reject);
  });
};

const ServerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const handlers = createServerHandlers();

    const server = createServer(async (req, res) => {
      try {
        const request = toWebRequest(req);
        const url = new URL(request.url);
        const response = url.pathname.startsWith('/mcp')
          ? await handlers.mcp.handleRequest(request)
          : await handlers.http.handler(request);
        await writeWebResponse(res, response);
      } catch (error) {
        console.error('[agentdock-server] request failed', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end('Internal Server Error');
      }
    });

    yield* Effect.acquireRelease(
      Effect.callback<void, Error>((resume) => {
        server.once('error', (error) => resume(Effect.fail(error)));
        server.listen(38123, () => {
          console.log('Listening on http://0.0.0.0:38123');
          console.log('MCP reachable at http://0.0.0.0:38123/mcp');
          resume(Effect.void);
        });
      }),
      () =>
        closeServerHandlers(handlers).pipe(
          Effect.andThen(
            Effect.promise(async () => {
              await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                  if (error) reject(error);
                  else resolve();
                });
              });
            }),
          ),
        ),
    );

    yield* bootstrapInternalAgentMcpSource({ endpoint: 'http://127.0.0.1:38123/mcp' }).pipe(
      Effect.provide(CoreServices),
      Effect.catch((error: unknown) =>
        Effect.sync(() => console.error('[agentdock-server] internal MCP bootstrap failed', error)),
      ),
    );
  }),
);

const Main = ensureDatabaseTables().pipe(Effect.andThen(Layer.launch(ServerLive)), Effect.provide(RuntimeLive));

NodeRuntime.runMain(Main);
