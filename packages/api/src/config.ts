import { localUrl, normalizeBaseUrl } from 'agentdock-sdk/config';
import { ports } from 'agentdock-sdk/ports';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';

const defaultTempoUrl = 'http://127.0.0.1:3200';

export type ServerConfigService = {
  readonly host: string;
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly webOrigin: string;
  readonly isProduction: boolean;
  readonly internalMcpEndpoint: string;
};
export const ServerConfig = Context.Service<ServerConfigService>('@agentdock/api/ServerConfig');
export const ServerConfigLive = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const host = yield* Config.String('AGENTDOCK_SERVER_HOST').pipe(Config.orElse(() => Config.succeed('127.0.0.1')));
    const port = yield* Config.Int('AGENTDOCK_SERVER_PORT').pipe(Config.orElse(() => Config.succeed(ports().api)));
    const apiBaseUrl = yield* Config.String('AGENTDOCK_API_URL').pipe(
      Config.orElse(() => Config.succeed(localUrl(port))),
    );
    const webOrigin = yield* Config.String('AGENTDOCK_WEB_ORIGIN').pipe(
      Config.orElse(() => Config.succeed(localUrl(port + 1))),
    );
    const nodeEnv = yield* Config.String('NODE_ENV').pipe(Config.orElse(() => Config.succeed('development')));
    return ServerConfig.of({
      host,
      port,
      apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
      webOrigin,
      isProduction: nodeEnv === 'production',
      internalMcpEndpoint: `http://127.0.0.1:${port}/mcp/internal`,
    });
  }),
);

export type AuthConfigService = {
  readonly baseUrl: string;
  readonly webOrigin: string;
  readonly secret: Redacted.Redacted;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly allowAllDevOrigins: boolean;
  readonly disabled: boolean;
};
export const AuthConfig = Context.Service<AuthConfigService>('@agentdock/api/AuthConfig');
export const AuthConfigLive = Layer.effect(
  AuthConfig,
  Effect.gen(function* () {
    const server = yield* ServerConfig;
    const authBaseUrl = yield* Config.String('BETTER_AUTH_URL').pipe(
      Config.orElse(() => Config.succeed(server.apiBaseUrl)),
    );
    const secret = yield* Config.Redacted('BETTER_AUTH_SECRET');
    const disabled = yield* Config.Boolean('AGENTDOCK_DISABLE_AUTH').pipe(Config.orElse(() => Config.succeed(false)));
    return AuthConfig.of({
      baseUrl: normalizeBaseUrl(authBaseUrl),
      webOrigin: server.webOrigin,
      secret,
      trustedOrigins: [server.webOrigin],
      allowAllDevOrigins: !server.isProduction,
      disabled,
    });
  }),
).pipe(Layer.provide(ServerConfigLive));

export type CorsConfigService = {
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly allowAllDevOrigins: boolean;
};
export const CorsConfig = Context.Service<CorsConfigService>('@agentdock/api/CorsConfig');
export const CorsConfigLive = Layer.effect(
  CorsConfig,
  Effect.gen(function* () {
    const server = yield* ServerConfig;
    return CorsConfig.of({
      allowedOrigins: [server.webOrigin],
      allowAllDevOrigins: !server.isProduction,
    });
  }),
).pipe(Layer.provide(ServerConfigLive));

export type TriggerConfigService = { readonly schedulerIntervalSeconds: number; readonly apiBaseUrl: string };
export const TriggerConfig = Context.Service<TriggerConfigService>('@agentdock/api/TriggerConfig');
export const TriggerConfigLive = Layer.effect(
  TriggerConfig,
  Effect.gen(function* () {
    const schedulerIntervalSeconds = yield* Config.Int('TRIGGER_SCHEDULER_INTERVAL_SECONDS').pipe(
      Config.orElse(() => Config.succeed(30)),
      Config.map((value) => (Number.isFinite(value) && value > 0 ? value : 30)),
    );
    const server = yield* ServerConfig;
    return TriggerConfig.of({ schedulerIntervalSeconds, apiBaseUrl: server.apiBaseUrl });
  }),
).pipe(Layer.provide(ServerConfigLive));

export type TempoConfigService = { readonly baseUrl: string };
export const TempoConfig = Context.Service<TempoConfigService>('@agentdock/api/TempoConfig');
export const TempoConfigLive = Layer.effect(
  TempoConfig,
  Effect.gen(function* () {
    const baseUrl = yield* Config.String('TEMPO_URL').pipe(Config.orElse(() => Config.succeed(defaultTempoUrl)));
    return TempoConfig.of({ baseUrl: normalizeBaseUrl(baseUrl) });
  }),
);

export type ObservabilityConfigService = { readonly serviceName: string; readonly otlpTraceEndpoint: string | null };
export const ObservabilityConfig = Context.Service<ObservabilityConfigService>('@agentdock/api/ObservabilityConfig');
export const ObservabilityConfigLive = Layer.effect(
  ObservabilityConfig,
  Effect.gen(function* () {
    const tracesEndpoint = yield* Config.option(Config.String('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'));
    const baseEndpoint = yield* Config.option(Config.String('OTEL_EXPORTER_OTLP_ENDPOINT'));
    const serviceName = yield* Config.String('OTEL_SERVICE_NAME').pipe(
      Config.orElse(() => Config.succeed('agentdock-api')),
    );
    return ObservabilityConfig.of({
      serviceName,
      otlpTraceEndpoint: Option.match(tracesEndpoint, {
        onSome: (value) => value,
        onNone: () =>
          Option.match(baseEndpoint, {
            onSome: (value) => `${normalizeBaseUrl(value)}/v1/traces`,
            onNone: () => null,
          }),
      }),
    });
  }),
);

export type GraphEmailConfig = {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
};

export type EmailGraphConfigService = { readonly config: GraphEmailConfig | null };
export const EmailGraphConfig = Context.Service<EmailGraphConfigService>('@agentdock/api/EmailGraphConfig');
export const EmailGraphConfigLive = Layer.effect(
  EmailGraphConfig,
  Effect.gen(function* () {
    const tenantId = yield* Config.option(Config.String('MS_GRAPH_TENANT_ID'));
    const clientId = yield* Config.option(Config.String('MS_GRAPH_CLIENT_ID'));
    const clientSecret = yield* Config.option(Config.Redacted('MS_GRAPH_CLIENT_SECRET'));
    if (Option.isSome(tenantId) && Option.isSome(clientId) && Option.isSome(clientSecret)) {
      return EmailGraphConfig.of({
        config: { tenantId: tenantId.value, clientId: clientId.value, clientSecret: clientSecret.value },
      });
    }
    return EmailGraphConfig.of({ config: null });
  }),
);

export type ProviderEnvConfigService = {
  readonly get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted>>;
};
export const ProviderEnvConfig = Context.Service<ProviderEnvConfigService>('@agentdock/api/ProviderEnvConfig');
export const ProviderEnvConfigLive = Layer.succeed(
  ProviderEnvConfig,
  ProviderEnvConfig.of({
    get: (name: string) =>
      Effect.orDie(
        Config.map(Config.option(Config.String(name)), (value) =>
          Option.flatMap(value, (raw) => (raw.length > 0 ? Option.some(Redacted.make(raw)) : Option.none())),
        ),
      ),
  }),
);
