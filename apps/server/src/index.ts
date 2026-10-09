import 'dotenv/config';
import type * as EffectType from 'effect/Effect';
import type * as HttpServerResponseType from 'effect/http/HttpServerResponse';

const [
  { NodeFileSystem, NodeHttpServer, NodeRuntime },
  { AuthLive, CoreServices, ServerConfig, ServerConfigLive, bootstrapInternalAgentMcpSource, GraphRuntime },
  { ensureDatabaseTables },
  { Cause, Effect: EffectModule, FileSystem, Layer, Logger, Option, Schedule },
  { createServer },
  { randomBytes },
  { createServerRoutes },
  { HttpRouter, HttpServer, HttpServerError, HttpServerRequest },
] = await Promise.all([
  import('@effect/platform-node'),
  import('api'),
  import('db/init'),
  import('effect'),
  import('node:http'),
  import('node:crypto'),
  import('./handlers'),
  import('effect/http'),
]);
const { ObservabilityLive } = await import('./observability');

const fileLogger = EffectModule.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory('logs', { recursive: true });
  return yield* Logger.formatLogFmt.pipe(Logger.toFile('logs/api.log'));
});
const LoggerLive = Logger.layer([Logger.consoleLogFmt, fileLogger, Logger.tracerLogger]).pipe(
  Layer.provide(NodeFileSystem.layer),
);
const RuntimeLive = Layer.mergeAll(LoggerLive, ObservabilityLive);

const requestPath = (url: string): string => new URL(url, 'http://localhost').pathname;

const requestLogger = <A extends HttpServerResponseType.HttpServerResponse, E, R>(
  httpApp: EffectType.Effect<A, E, R>,
) =>
  EffectModule.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const started = performance.now();
    const exit = yield* EffectModule.exit(httpApp);
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const [response, cause] =
      exit._tag === 'Success' ? [exit.value, Option.none()] : HttpServerError.causeResponseStripped(exit.cause);

    const annotations = {
      'http.method': request.method,
      'http.url': requestPath(request.originalUrl),
      'http.status': String(response.status),
      'http.duration_ms': String(durationMs),
    };

    const log = Option.match(
      Option.filter(cause, (remaining) => !Cause.hasInterruptsOnly(remaining)),
      {
        onNone: () => EffectModule.logInfo('HTTP request'),
        onSome: (failure) => EffectModule.logError(failure),
      },
    );
    return yield* EffectModule.andThen(EffectModule.annotateLogs(log, annotations), exit);
  });

const bootstrapInternalMcp = (internalToken: string) =>
  Layer.effectDiscard(
    EffectModule.gen(function* () {
      const serverConfig = yield* ServerConfig;
      yield* HttpServer.HttpServer;
      const graphs = yield* GraphRuntime;
      yield* EffectModule.promise(() => graphs.recover()).pipe(
        EffectModule.catchCause(EffectModule.logError),
        EffectModule.repeat({ schedule: Schedule.spaced('5 seconds') }),
        EffectModule.forkScoped,
      );
      yield* EffectModule.log(`API listening at ${serverConfig.apiBaseUrl}`);
      yield* EffectModule.log(`MCP reachable at ${serverConfig.apiBaseUrl}/mcp`);
      // The bootstrap registers an internal MCP source pointing at this server's
      // own /mcp/internal endpoint, which it then probes over HTTP. Awaiting it here would
      // deadlock: this effect is part of the server layer's construction, so the
      // router does not start dispatching until it completes — yet the probe
      // cannot succeed until the router dispatches. Fork it so the server starts
      // serving immediately and the self-request is handled. Scoped to the server
      // lifetime so it is interrupted on shutdown.
      yield* bootstrapInternalAgentMcpSource({ endpoint: serverConfig.internalMcpEndpoint, token: internalToken }).pipe(
        EffectModule.provide(CoreServices),
        // catchCause, not catch: a defect here would otherwise vanish with the fiber.
        EffectModule.catchCause((cause) =>
          EffectModule.logError('[agentdock-server] internal MCP bootstrap failed', cause),
        ),
        EffectModule.forkScoped,
      );
    }),
  );

const ServerLive = Layer.unwrap(
  EffectModule.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const internalToken = randomBytes(32).toString('base64url');
    return HttpRouter.serve(createServerRoutes({ internalToken }), {
      disableLogger: true,
      middleware: requestLogger,
    }).pipe(
      Layer.provideMerge(bootstrapInternalMcp(internalToken)),
      Layer.provideMerge(CoreServices),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: serverConfig.host,
          port: serverConfig.port,
          gracefulShutdownTimeout: '1 second',
        }),
      ),
    );
  }),
).pipe(Layer.provide(ServerConfigLive));

const Main = ensureDatabaseTables().pipe(
  EffectModule.andThen(Layer.launch(ServerLive)),
  EffectModule.provide(Layer.mergeAll(RuntimeLive, Layer.orDie(AuthLive))),
);

NodeRuntime.runMain(Main);
