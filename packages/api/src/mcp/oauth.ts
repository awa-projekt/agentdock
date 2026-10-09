import * as NodeCrypto from 'node:crypto';
import { randomUUIDv4 } from 'agentdock-sdk';
import {
  McpAuthorizationRequestId,
  type McpAuthorizationRequestView,
  type McpClientKind,
  McpGrantId,
  type McpGrantView,
} from 'agentdock-sdk/schemas';
import {
  authUserTable,
  Database,
  mcpOAuthClientsTable,
  mcpOAuthGrantsTable,
  mcpOAuthRequestsTable,
  mcpOAuthTokensTable,
  tryDbWith,
} from 'db';
import { and, eq, lt } from 'drizzle-orm';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { AuthConfig, ServerConfig } from '../config';
import { ChangeFeed, ChangeFeedLive } from '../events/service';

const SCOPE = 'mcp';
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const METADATA_TIMEOUT = '5 seconds';

/** A failure the OAuth spec says to report to the client as `{ error, error_description }`. */
export class OAuthProtocolError extends Schema.TaggedError<OAuthProtocolError>()('OAuthProtocolError', {
  error: Schema.String,
  description: Schema.String,
  status: Schema.Number,
}) {}

/** A consent or grant operation the dashboard asked for that cannot be done. */
export class McpOAuthError extends Schema.TaggedError<McpOAuthError>()('McpOAuthError', {
  message: Schema.String,
  notFound: Schema.Boolean,
}) {}

class McpOAuthStoreError extends Schema.TaggedError<McpOAuthStoreError>()('McpOAuthStoreError', {
  cause: Schema.Defect(),
}) {}

const tryDb = tryDbWith((cause) => new McpOAuthStoreError({ cause }));

const protocolError = (error: string, description: string, status = 400) =>
  new OAuthProtocolError({ error, description, status });

const notFound = (message: string) => new McpOAuthError({ message, notFound: true });

const ClientMetadata = Schema.Struct({
  client_name: Schema.optional(Schema.String),
  redirect_uris: Schema.NonEmptyArray(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
});
type ClientMetadata = typeof ClientMetadata.Type;

const ClientMetadataDocument = Schema.Struct({ ...ClientMetadata.fields, client_id: Schema.String });

const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMetadata));
const decodeMetadataDocument = Schema.decodeUnknownEffect(ClientMetadataDocument);

const AuthorizeParams = Schema.Struct({
  response_type: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String),
  redirect_uri: Schema.optional(Schema.String),
  code_challenge: Schema.optional(Schema.String),
  code_challenge_method: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
});
const decodeAuthorizeParams = Schema.decodeUnknownEffect(AuthorizeParams);

const TokenParams = Schema.Struct({
  grant_type: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  code_verifier: Schema.optional(Schema.String),
  redirect_uri: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
});
const decodeTokenParams = Schema.decodeUnknownEffect(TokenParams);

const codeChallengePattern = /^[A-Za-z0-9._~-]{43,128}$/;

const sha256Hex = (value: string): string => NodeCrypto.createHash('sha256').update(value).digest('hex');
const sha256Base64Url = (value: string): string => NodeCrypto.createHash('sha256').update(value).digest('base64url');
const secret = (prefix: string): string => `${prefix}${NodeCrypto.randomBytes(32).toString('base64url')}`;

const parsedUrl = (value: string): URL | undefined => (URL.canParse(value) ? new URL(value) : undefined);

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

const isPrivateHost = (hostname: string): boolean =>
  isLoopback(hostname) ||
  hostname.endsWith('.local') ||
  hostname.endsWith('.internal') ||
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(hostname) ||
  hostname.startsWith('[');

const safeRedirectUri = (value: string): boolean => {
  const url = parsedUrl(value);
  if (url === undefined || url.hash !== '' || url.username !== '' || url.password !== '') return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
};

const safeClientMetadata = (metadata: ClientMetadata): boolean =>
  metadata.redirect_uris.every(safeRedirectUri) &&
  (metadata.token_endpoint_auth_method === undefined || metadata.token_endpoint_auth_method === 'none') &&
  (metadata.response_types ?? ['code']).every((type) => type === 'code') &&
  (metadata.grant_types ?? ['authorization_code']).includes('authorization_code') &&
  (metadata.grant_types ?? []).every((grant) => grant === 'authorization_code' || grant === 'refresh_token');

/** A client metadata document URL: https, a real path, and a host that is not on a private network. */
const metadataDocumentUrl = (clientId: string): URL | undefined => {
  const url = parsedUrl(clientId);
  if (url === undefined || url.protocol !== 'https:' || url.pathname === '/' || url.hash !== '') return undefined;
  if (url.username !== '' || url.password !== '' || isPrivateHost(url.hostname)) return undefined;
  return url;
};

/**
 * Native clients listen on an ephemeral loopback port, so a registered
 * loopback redirect matches the same URI on any port (RFC 8252 §7.3).
 */
const redirectUriRegistered = (registered: ReadonlyArray<string>, requested: string): boolean => {
  if (registered.includes(requested)) return true;
  const url = parsedUrl(requested);
  if (url === undefined || url.protocol !== 'http:' || !isLoopback(url.hostname)) return false;
  return registered.some((candidate) => {
    const known = parsedUrl(candidate);
    if (known === undefined || known.protocol !== 'http:' || !isLoopback(known.hostname)) return false;
    return known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
  });
};

export type McpPrincipal = { readonly userId: string; readonly grantId: string };

export type RegisteredClient = ClientMetadata & {
  readonly client_name: string;
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly token_endpoint_auth_method: 'none';
};

export type McpTokenResponse = {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
};

export type McpOAuthService = {
  /** The one protected resource: this server's `/mcp` endpoint. */
  readonly resource: string;
  readonly issuer: string;
  readonly protectedResourcePath: `/${string}`;
  readonly protectedResourceMetadata: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly authorizationServerMetadata: Readonly<Record<string, string | boolean | ReadonlyArray<string>>>;
  readonly challenge: (error?: 'invalid_token') => string;
  readonly register: (body: string) => Effect.Effect<RegisteredClient, OAuthProtocolError>;
  /** Validates an authorization request and returns where to send the browser: consent, or back with an error. */
  readonly authorize: (params: URLSearchParams) => Effect.Effect<string, OAuthProtocolError>;
  readonly token: (params: URLSearchParams) => Effect.Effect<McpTokenResponse, OAuthProtocolError>;
  readonly authenticate: (accessToken: string) => Effect.Effect<McpPrincipal | undefined, McpOAuthError>;
  readonly getRequest: (requestId: string) => Effect.Effect<McpAuthorizationRequestView, McpOAuthError>;
  readonly decide: (requestId: string, userId: string, approve: boolean) => Effect.Effect<string, McpOAuthError>;
  readonly listGrants: (userId: string) => Effect.Effect<ReadonlyArray<McpGrantView>, McpOAuthError>;
  readonly revokeGrant: (userId: string, grantId: string) => Effect.Effect<boolean, McpOAuthError>;
};

export const McpOAuth = Context.Service<McpOAuthService>('@agentdock/api/McpOAuth');

const storeFailure = (error: McpOAuthStoreError) =>
  Effect.logError('[agentdock-mcp-oauth] store failure', error.cause).pipe(
    Effect.andThen(Effect.fail(new McpOAuthError({ message: 'The authorization store failed', notFound: false }))),
  );

const storeFailureAsProtocol = (error: McpOAuthStoreError) =>
  Effect.logError('[agentdock-mcp-oauth] store failure', error.cause).pipe(
    Effect.andThen(Effect.fail(protocolError('server_error', 'The authorization store failed', 500))),
  );

export const McpOAuthLive = Layer.effect(
  McpOAuth,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const server = yield* ServerConfig;
    const authConfig = yield* AuthConfig;
    const http = yield* HttpClient.HttpClient;
    const changes = yield* ChangeFeed;

    const issuer = new URL(server.apiBaseUrl).origin;
    const resource = `${server.apiBaseUrl}/mcp`;
    const protectedResourcePath: `/${string}` = `/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
    const consentUrl = `${server.webOrigin}/oauth/consent`;

    const protectedResourceMetadata = {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
    };

    const authorizationServerMetadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };

    const challenge = (error?: 'invalid_token') =>
      `Bearer resource_metadata="${issuer}${protectedResourcePath}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;

    const now = Clock.currentTimeMillis;

    const sweep = Effect.gen(function* () {
      const at = yield* now;
      yield* tryDb(() => db.delete(mcpOAuthRequestsTable).where(lt(mcpOAuthRequestsTable.expiresAt, at)).run());
      yield* tryDb(() => db.delete(mcpOAuthTokensTable).where(lt(mcpOAuthTokensTable.expiresAt, at)).run());
    });

    const findClient = (clientId: string) =>
      tryDb(() => db.select().from(mcpOAuthClientsTable).where(eq(mcpOAuthClientsTable.clientId, clientId)).get());

    const saveClient = Effect.fn('McpOAuth.saveClient')(function* (
      kind: McpClientKind,
      clientId: string,
      metadata: ClientMetadata,
    ) {
      const existing = yield* findClient(clientId);
      const row = {
        id: existing?.id ?? `mcpc_${yield* randomUUIDv4}`,
        kind,
        clientId,
        name: metadata.client_name?.trim() || new URL(metadata.redirect_uris[0]).host || clientId,
        redirectUris: metadata.redirect_uris,
        createdAt: existing?.createdAt ?? (yield* now),
      };
      yield* tryDb(() =>
        db
          .insert(mcpOAuthClientsTable)
          .values(row)
          .onConflictDoUpdate({
            target: mcpOAuthClientsTable.clientId,
            set: { name: row.name, redirectUris: row.redirectUris },
          })
          .run(),
      );
      return row;
    });

    const fetchMetadataDocument = (url: URL) => {
      const unavailable = protocolError('invalid_client', `Could not load the client metadata document at ${url}`);
      return Effect.gen(function* () {
        const response = yield* http.get(url, { headers: { accept: 'application/json' } });
        if (response.status !== 200) return yield* unavailable;
        return yield* decodeMetadataDocument(yield* response.json);
      }).pipe(
        Effect.timeout(METADATA_TIMEOUT),
        Effect.mapError(() => unavailable),
      );
    };

    /** A client id is either one this server issued at registration, or the URL of the client's own metadata document. */
    const resolveClient = Effect.fn('McpOAuth.resolveClient')(function* (clientId: string) {
      const documentUrl = metadataDocumentUrl(clientId);
      if (documentUrl === undefined) {
        const registered = yield* findClient(clientId);
        if (registered === undefined) return yield* protocolError('invalid_client', 'Unknown client_id');
        return registered;
      }
      const document = yield* fetchMetadataDocument(documentUrl);
      if (document.client_id !== clientId || !safeClientMetadata(document)) {
        return yield* protocolError('invalid_client', 'The client metadata document is not acceptable');
      }
      return yield* saveClient('cimd', clientId, document);
    });

    const issueTokens = Effect.fn('McpOAuth.issueTokens')(function* (grantId: string, familyId: string) {
      const at = yield* Clock.currentTimeMillis;
      const accessToken = secret('adat_');
      const refreshToken = secret('adrt_');
      yield* tryDb(() =>
        db
          .insert(mcpOAuthTokensTable)
          .values([
            {
              hash: sha256Hex(accessToken),
              kind: 'access' as const,
              grantId,
              familyId,
              expiresAt: at + ACCESS_TTL_MS,
            },
            {
              hash: sha256Hex(refreshToken),
              kind: 'refresh' as const,
              grantId,
              familyId,
              expiresAt: at + REFRESH_TTL_MS,
            },
          ])
          .run(),
      );
      return {
        access_token: accessToken,
        token_type: 'Bearer' as const,
        expires_in: ACCESS_TTL_MS / 1000,
        refresh_token: refreshToken,
        scope: SCOPE,
      };
    });

    const findToken = (token: string, kind: 'code' | 'access' | 'refresh') =>
      tryDb(() =>
        db
          .select({ token: mcpOAuthTokensTable, grant: mcpOAuthGrantsTable, client: mcpOAuthClientsTable })
          .from(mcpOAuthTokensTable)
          .innerJoin(mcpOAuthGrantsTable, eq(mcpOAuthTokensTable.grantId, mcpOAuthGrantsTable.id))
          .innerJoin(mcpOAuthClientsTable, eq(mcpOAuthGrantsTable.clientId, mcpOAuthClientsTable.id))
          .where(and(eq(mcpOAuthTokensTable.hash, sha256Hex(token)), eq(mcpOAuthTokensTable.kind, kind)))
          .get(),
      );

    const exchangeCode = Effect.fn('McpOAuth.exchangeCode')(function* (params: typeof TokenParams.Type) {
      const { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId } = params;
      if (!code || !verifier || !redirectUri || !clientId) {
        return yield* protocolError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required');
      }
      const found = yield* findToken(code, 'code');
      if (found === undefined) return yield* protocolError('invalid_grant', 'Unknown or already used code');
      yield* tryDb(() => db.delete(mcpOAuthTokensTable).where(eq(mcpOAuthTokensTable.hash, found.token.hash)).run());
      const at = yield* now;
      if (
        found.token.expiresAt < at ||
        found.client.clientId !== clientId ||
        found.token.redirectUri !== redirectUri ||
        found.token.codeChallenge !== sha256Base64Url(verifier)
      ) {
        return yield* protocolError('invalid_grant', 'The code does not match this request');
      }
      return yield* issueTokens(found.grant.id, found.token.familyId);
    });

    const refresh = Effect.fn('McpOAuth.refresh')(function* (params: typeof TokenParams.Type) {
      const { refresh_token: refreshToken, client_id: clientId } = params;
      if (!refreshToken || !clientId) {
        return yield* protocolError('invalid_request', 'refresh_token and client_id are required');
      }
      const found = yield* findToken(refreshToken, 'refresh');
      const at = yield* now;
      if (found === undefined || found.token.expiresAt < at || found.client.clientId !== clientId) {
        return yield* protocolError('invalid_grant', 'Unknown or expired refresh token');
      }
      if (found.token.usedAt !== null) {
        yield* tryDb(() =>
          db.delete(mcpOAuthTokensTable).where(eq(mcpOAuthTokensTable.familyId, found.token.familyId)).run(),
        );
        return yield* protocolError('invalid_grant', 'The refresh token was already used');
      }
      yield* tryDb(() =>
        db.update(mcpOAuthTokensTable).set({ usedAt: at }).where(eq(mcpOAuthTokensTable.hash, found.token.hash)).run(),
      );
      return yield* issueTokens(found.grant.id, found.token.familyId);
    });

    const isAdmin = Effect.fn('McpOAuth.isAdmin')(function* (userId: string) {
      if (authConfig.disabled) return true;
      const user = yield* tryDb(() =>
        db.select({ role: authUserTable.role }).from(authUserTable).where(eq(authUserTable.id, userId)).get(),
      );
      return user?.role === 'admin';
    });

    const pendingRequest = Effect.fn('McpOAuth.pendingRequest')(function* (requestId: string) {
      const found = yield* tryDb(() =>
        db
          .select({ request: mcpOAuthRequestsTable, client: mcpOAuthClientsTable })
          .from(mcpOAuthRequestsTable)
          .innerJoin(mcpOAuthClientsTable, eq(mcpOAuthRequestsTable.clientId, mcpOAuthClientsTable.id))
          .where(eq(mcpOAuthRequestsTable.id, requestId))
          .get(),
      );
      if (found === undefined || found.request.expiresAt < (yield* now)) {
        return yield* notFound('This authorization request is unknown or has expired. Start the connection again.');
      }
      return found;
    });

    return McpOAuth.of({
      resource,
      issuer,
      protectedResourcePath,
      protectedResourceMetadata,
      authorizationServerMetadata,
      challenge,

      register: Effect.fn('McpOAuth.register')(
        function* (body) {
          const metadata = yield* decodeRegistration(body).pipe(
            Effect.mapError(() => protocolError('invalid_client_metadata', 'redirect_uris is required')),
          );
          if (!safeClientMetadata(metadata)) {
            return yield* protocolError(
              'invalid_client_metadata',
              'Only public clients using the authorization code flow with https or loopback redirect URIs are supported',
            );
          }
          const client = yield* saveClient('dcr', `mcpc_${yield* randomUUIDv4}`, metadata);
          return {
            ...metadata,
            client_name: client.name,
            client_id: client.clientId,
            client_id_issued_at: Math.floor(client.createdAt / 1000),
            token_endpoint_auth_method: 'none' as const,
          };
        },
        Effect.catchTag('McpOAuthStoreError', storeFailureAsProtocol),
      ),

      authorize: Effect.fn('McpOAuth.authorize')(
        function* (searchParams) {
          yield* sweep;
          const params = yield* decodeAuthorizeParams(Object.fromEntries(searchParams)).pipe(
            Effect.mapError(() => protocolError('invalid_request', 'Malformed authorization request')),
          );
          if (!params.client_id) return yield* protocolError('invalid_request', 'client_id is required');
          const client = yield* resolveClient(params.client_id);
          const redirectUri =
            params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
          if (redirectUri === undefined || !redirectUriRegistered(client.redirectUris, redirectUri)) {
            return yield* protocolError('invalid_request', 'redirect_uri is not registered for this client');
          }
          const back = (error: string, description: string) => {
            const target = new URL(redirectUri);
            target.searchParams.set('error', error);
            target.searchParams.set('error_description', description);
            if (params.state !== undefined) target.searchParams.set('state', params.state);
            target.searchParams.set('iss', issuer);
            return target.toString();
          };
          if (params.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
          if (params.code_challenge_method !== 'S256' || !codeChallengePattern.test(params.code_challenge ?? '')) {
            return back('invalid_request', 'A PKCE S256 code_challenge is required');
          }
          if (params.resource !== undefined && params.resource !== resource) {
            return back('invalid_target', `resource must be ${resource}`);
          }
          const id = `mcpreq_${yield* randomUUIDv4}`;
          const at = yield* Clock.currentTimeMillis;
          yield* tryDb(() =>
            db
              .insert(mcpOAuthRequestsTable)
              .values({
                id,
                clientId: client.id,
                redirectUri,
                state: params.state ?? null,
                codeChallenge: params.code_challenge ?? '',
                expiresAt: at + REQUEST_TTL_MS,
              })
              .run(),
          );
          return `${consentUrl}?request=${encodeURIComponent(id)}`;
        },
        Effect.catchTag('McpOAuthStoreError', storeFailureAsProtocol),
      ),

      token: Effect.fn('McpOAuth.token')(
        function* (searchParams) {
          yield* sweep;
          const params = yield* decodeTokenParams(Object.fromEntries(searchParams)).pipe(
            Effect.mapError(() => protocolError('invalid_request', 'Malformed token request')),
          );
          if (params.resource !== undefined && params.resource !== resource) {
            return yield* protocolError('invalid_target', `resource must be ${resource}`);
          }
          switch (params.grant_type) {
            case 'authorization_code':
              return yield* exchangeCode(params);
            case 'refresh_token':
              return yield* refresh(params);
            default:
              return yield* protocolError('unsupported_grant_type', 'Use authorization_code or refresh_token');
          }
        },
        Effect.catchTag('McpOAuthStoreError', storeFailureAsProtocol),
      ),

      authenticate: Effect.fn('McpOAuth.authenticate')(
        function* (accessToken) {
          const found = yield* findToken(accessToken, 'access');
          const at = yield* now;
          if (found === undefined || found.token.expiresAt < at) return undefined;
          if (!(yield* isAdmin(found.grant.userId))) return undefined;
          yield* tryDb(() =>
            db
              .update(mcpOAuthGrantsTable)
              .set({ lastUsedAt: at })
              .where(eq(mcpOAuthGrantsTable.id, found.grant.id))
              .run(),
          );
          return { userId: found.grant.userId, grantId: found.grant.id };
        },
        Effect.catchTag('McpOAuthStoreError', storeFailure),
      ),

      getRequest: Effect.fn('McpOAuth.getRequest')(
        function* (requestId) {
          const { request, client } = yield* pendingRequest(requestId);
          return {
            id: McpAuthorizationRequestId.make(request.id),
            clientName: client.name,
            clientId: client.clientId,
            clientKind: client.kind,
            redirectOrigin: new URL(request.redirectUri).origin,
          };
        },
        Effect.catchTag('McpOAuthStoreError', storeFailure),
      ),

      decide: Effect.fn('McpOAuth.decide')(
        function* (requestId, userId, approve) {
          const { request } = yield* pendingRequest(requestId);
          yield* tryDb(() => db.delete(mcpOAuthRequestsTable).where(eq(mcpOAuthRequestsTable.id, request.id)).run());
          const target = new URL(request.redirectUri);
          if (request.state !== null) target.searchParams.set('state', request.state);
          target.searchParams.set('iss', issuer);
          if (!approve) {
            target.searchParams.set('error', 'access_denied');
            return target.toString();
          }
          if (!(yield* isAdmin(userId))) {
            return yield* new McpOAuthError({ message: 'Only admins can connect coding agents', notFound: false });
          }
          const at = yield* now;
          const grantId = `mcpg_${yield* randomUUIDv4}`;
          const grant = yield* tryDb(() =>
            db
              .insert(mcpOAuthGrantsTable)
              .values({ id: grantId, clientId: request.clientId, userId, createdAt: at })
              .onConflictDoUpdate({
                target: [mcpOAuthGrantsTable.clientId, mcpOAuthGrantsTable.userId],
                set: { clientId: request.clientId },
              })
              .returning({ id: mcpOAuthGrantsTable.id })
              .get(),
          );
          const code = secret('adoc_');
          const familyId = `mcpf_${yield* randomUUIDv4}`;
          yield* tryDb(() =>
            db
              .insert(mcpOAuthTokensTable)
              .values({
                hash: sha256Hex(code),
                kind: 'code',
                grantId: grant.id,
                familyId,
                redirectUri: request.redirectUri,
                codeChallenge: request.codeChallenge,
                expiresAt: at + CODE_TTL_MS,
              })
              .run(),
          );
          target.searchParams.set('code', code);
          return target.toString();
        },
        Effect.catchTag('McpOAuthStoreError', storeFailure),
        changes.touches('mcpAccess'),
      ),

      listGrants: Effect.fn('McpOAuth.listGrants')(
        function* (userId) {
          const rows = yield* tryDb(() =>
            db
              .select({ grant: mcpOAuthGrantsTable, client: mcpOAuthClientsTable })
              .from(mcpOAuthGrantsTable)
              .innerJoin(mcpOAuthClientsTable, eq(mcpOAuthGrantsTable.clientId, mcpOAuthClientsTable.id))
              .where(eq(mcpOAuthGrantsTable.userId, userId))
              .all(),
          );
          return rows.map(({ grant, client }) => ({
            id: McpGrantId.make(grant.id),
            clientName: client.name,
            clientId: client.clientId,
            createdAt: grant.createdAt,
            lastUsedAt: grant.lastUsedAt,
          }));
        },
        Effect.catchTag('McpOAuthStoreError', storeFailure),
      ),

      revokeGrant: Effect.fn('McpOAuth.revokeGrant')(
        function* (userId, grantId) {
          const owned = yield* tryDb(() =>
            db
              .select({ id: mcpOAuthGrantsTable.id })
              .from(mcpOAuthGrantsTable)
              .where(and(eq(mcpOAuthGrantsTable.id, grantId), eq(mcpOAuthGrantsTable.userId, userId)))
              .get(),
          );
          if (owned === undefined) return false;
          yield* tryDb(() => db.delete(mcpOAuthTokensTable).where(eq(mcpOAuthTokensTable.grantId, owned.id)).run());
          yield* tryDb(() => db.delete(mcpOAuthGrantsTable).where(eq(mcpOAuthGrantsTable.id, owned.id)).run());
          return true;
        },
        Effect.catchTag('McpOAuthStoreError', storeFailure),
        changes.touches('mcpAccess'),
      ),
    });
  }),
).pipe(Layer.provide(ChangeFeedLive));
