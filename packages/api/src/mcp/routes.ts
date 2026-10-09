import * as NodeCrypto from 'node:crypto';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import { SkillRegistry } from '../skills/service';
import { withHttpRootSpan } from '../tracing';
import { McpOAuth, type OAuthProtocolError } from './oauth';

const noStore = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };

const json = (body: Parameters<typeof HttpServerResponse.jsonUnsafe>[0], status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

const oauthError = (error: OAuthProtocolError) =>
  json({ error: error.error, error_description: error.description }, error.status);

const ProtectedResourceRoute = Effect.gen(function* () {
  const oauth = yield* McpOAuth;
  return HttpRouter.add('GET', oauth.protectedResourcePath, json(oauth.protectedResourceMetadata));
});

const AuthorizationServerRoute = HttpRouter.add(
  'GET',
  '/.well-known/oauth-authorization-server',
  McpOAuth.use((oauth) => Effect.succeed(json(oauth.authorizationServerMetadata))),
);

const RegisterRoute = HttpRouter.add(
  'POST',
  '/oauth/register',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ''));
    const oauth = yield* McpOAuth;
    return yield* oauth.register(body).pipe(
      Effect.map((client) => json(client, 201)),
      Effect.catchTag('OAuthProtocolError', (error) => Effect.succeed(oauthError(error))),
    );
  }).pipe(withHttpRootSpan('agentdock.http.request.oauth.register')),
);

const AuthorizeRoute = HttpRouter.add(
  'GET',
  '/oauth/authorize',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const oauth = yield* McpOAuth;
    return yield* oauth.authorize(new URL(request.url, oauth.issuer).searchParams).pipe(
      Effect.map((location) => HttpServerResponse.redirect(location, { status: 302, headers: noStore })),
      Effect.catchTag('OAuthProtocolError', (error) => Effect.succeed(oauthError(error))),
    );
  }).pipe(withHttpRootSpan('agentdock.http.request.oauth.authorize')),
);

const TokenRoute = HttpRouter.add(
  'POST',
  '/oauth/token',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ''));
    const oauth = yield* McpOAuth;
    return yield* oauth.token(new URLSearchParams(body)).pipe(
      Effect.map((tokens) => json(tokens)),
      Effect.catchTag('OAuthProtocolError', (error) => Effect.succeed(oauthError(error))),
    );
  }).pipe(withHttpRootSpan('agentdock.http.request.oauth.token')),
);

const SKILLS_DISCOVERY_PATH = '/.well-known/agent-skills';
const SKILLS_DISCOVERY_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

/**
 * The skills that ship with the server, published for the `skills` CLI
 * (`npx skills add <agentdock url>`) so a coding agent can install the same
 * guide the built-in assistant runs with.
 */
const SkillsIndexRoute = HttpRouter.add(
  'GET',
  `${SKILLS_DISCOVERY_PATH}/index.json`,
  SkillRegistry.use((registry) =>
    Effect.succeed(
      json({
        $schema: SKILLS_DISCOVERY_SCHEMA,
        skills: registry.listBuiltin().map((skill) => ({
          name: skill.id,
          description: skill.description,
          type: 'skill-md',
          url: `${SKILLS_DISCOVERY_PATH}/${skill.id}/SKILL.md`,
          digest: `sha256:${NodeCrypto.createHash('sha256').update(skill.content).digest('hex')}`,
        })),
      }),
    ),
  ),
);

const SkillDocumentRoute = HttpRouter.add(
  'GET',
  `${SKILLS_DISCOVERY_PATH}/:skillId/SKILL.md`,
  Effect.gen(function* () {
    const { skillId } = yield* HttpRouter.params;
    const registry = yield* SkillRegistry;
    const skill = registry.listBuiltin().find((candidate) => candidate.id === skillId);
    if (skill === undefined) return HttpServerResponse.text('Not found', { status: 404 });
    return HttpServerResponse.text(skill.content, {
      contentType: 'text/markdown; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
    });
  }),
);

export const McpOAuthRoutes = Layer.mergeAll(
  Layer.unwrap(ProtectedResourceRoute),
  AuthorizationServerRoute,
  RegisterRoute,
  AuthorizeRoute,
  TokenRoute,
  SkillsIndexRoute,
  SkillDocumentRoute,
);
