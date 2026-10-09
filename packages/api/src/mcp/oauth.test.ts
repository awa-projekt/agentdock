import * as NodeCrypto from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { DatabaseLive } from 'db';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { AuthConfig, ServerConfig } from '../config';
import { McpOAuth, McpOAuthLive } from './oauth';

const API = 'http://127.0.0.1:38123';
const WEB = 'http://127.0.0.1:38124';
const USER = 'admin-user';

const TestLayer = McpOAuthLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      DatabaseLive,
      Layer.succeed(ServerConfig, {
        host: '127.0.0.1',
        port: 38123,
        apiBaseUrl: API,
        webOrigin: WEB,
        isProduction: false,
        internalMcpEndpoint: `${API}/mcp/internal`,
      }),
      Layer.succeed(AuthConfig, {
        baseUrl: API,
        webOrigin: WEB,
        secret: Redacted.make('secret'),
        trustedOrigins: [WEB],
        allowAllDevOrigins: true,
        disabled: true,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die('The OAuth flow under test must not reach the network')),
      ),
    ),
  ),
);

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const verifier = 'v'.repeat(64);
const challenge = NodeCrypto.createHash('sha256').update(verifier).digest('base64url');

/** Registers a loopback client, approves an authorization for it and returns the issued tokens. */
const connectClient = Effect.gen(function* () {
  const oauth = yield* McpOAuth;
  const client = yield* oauth.register(
    toJson({
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  );
  const redirectUri = 'http://127.0.0.1:9876/callback';
  const consent = new URL(
    yield* oauth.authorize(
      new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'opaque',
        resource: `${API}/mcp`,
      }),
    ),
  );
  const requestId = consent.searchParams.get('request') ?? '';
  const back = new URL(yield* oauth.decide(requestId, USER, true));
  const tokens = yield* oauth.token(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
    }),
  );
  return { client, consent, back, tokens };
});

describe('McpOAuth', () => {
  it.effect('issues tokens through registration, consent and PKCE, and they authenticate MCP calls', () =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const { client, consent, back, tokens } = yield* connectClient;

      expect(consent.origin + consent.pathname).toBe(`${WEB}/oauth/consent`);
      expect(back.searchParams.get('state')).toBe('opaque');
      expect(back.searchParams.get('iss')).toBe(API);
      expect(yield* oauth.authenticate(tokens.access_token)).toMatchObject({ userId: USER });
      expect(yield* oauth.listGrants(USER)).toContainEqual(expect.objectContaining({ clientId: client.client_id }));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('rotates refresh tokens and revokes the family when a spent one is replayed', () =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const { client, tokens } = yield* connectClient;
      const refresh = (token: string) =>
        oauth.token(
          new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id }),
        );

      const rotated = yield* refresh(tokens.refresh_token);
      const replay = yield* Effect.flip(refresh(tokens.refresh_token));

      expect(replay.error).toBe('invalid_grant');
      expect(yield* oauth.authenticate(rotated.access_token)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('refuses a code exchanged with the wrong verifier and lets a code be used only once', () =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const client = yield* oauth.register(toJson({ redirect_uris: ['http://localhost/cb'] }));
      const authorize = () =>
        oauth
          .authorize(
            new URLSearchParams({
              response_type: 'code',
              client_id: client.client_id,
              redirect_uri: 'http://localhost:5555/cb',
              code_challenge: challenge,
              code_challenge_method: 'S256',
            }),
          )
          .pipe(
            Effect.flatMap((consent) => oauth.decide(new URL(consent).searchParams.get('request') ?? '', USER, true)),
            Effect.map((back) => new URL(back).searchParams.get('code') ?? ''),
          );
      const exchange = (code: string, codeVerifier: string) =>
        oauth.token(
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: codeVerifier,
            redirect_uri: 'http://localhost:5555/cb',
            client_id: client.client_id,
          }),
        );

      const wrongVerifier = yield* Effect.flip(exchange(yield* authorize(), 'w'.repeat(64)));
      const code = yield* authorize();
      yield* exchange(code, verifier);
      const reused = yield* Effect.flip(exchange(code, verifier));

      expect(wrongVerifier.error).toBe('invalid_grant');
      expect(reused.error).toBe('invalid_grant');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('rejects clients whose redirect URIs are neither https nor loopback', () =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const rejected = yield* Effect.flip(
        oauth.register(toJson({ client_name: 'Sketchy', redirect_uris: ['http://evil.example/cb'] })),
      );

      expect(rejected.error).toBe('invalid_client_metadata');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('sends a denied authorization back to the client and revoking a grant ends its tokens', () =>
    Effect.gen(function* () {
      const oauth = yield* McpOAuth;
      const { client, tokens } = yield* connectClient;
      const consent = yield* oauth.authorize(
        new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:4000/callback',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      );
      const denied = new URL(yield* oauth.decide(new URL(consent).searchParams.get('request') ?? '', USER, false));
      const grant = (yield* oauth.listGrants(USER)).find((candidate) => candidate.clientId === client.client_id);

      expect(denied.searchParams.get('error')).toBe('access_denied');
      expect(denied.searchParams.has('code')).toBe(false);
      expect(yield* oauth.revokeGrant(USER, grant?.id ?? '')).toBe(true);
      expect(yield* oauth.authenticate(tokens.access_token)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );
});
