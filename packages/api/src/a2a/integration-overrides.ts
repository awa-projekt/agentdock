import { requestedIntegrationOverrides } from 'agentdock-sdk';
import {
  INTEGRATION_OVERRIDES_METADATA_KEY,
  type IntegrationView,
  isJsonObject,
  type Json,
  jsonProperty,
  jsonString,
} from 'agentdock-sdk/schemas';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import type { Auth } from '../auth';
import { getSessionUser } from '../auth-middleware';
import type { AuthConfig } from '../config';
import { IntegrationCatalog } from '../gateway/catalog';

const isHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
};

/** Who is asking, and what is registered: all the admission needs to know. */
export type OverrideAdmission = {
  /** The caller's role, `null` for nobody signed in. */
  readonly callerRole: Effect.Effect<string | null>;
  readonly integrations: Effect.Effect<ReadonlyArray<Pick<IntegrationView, 'slug' | 'kind'>>, Error>;
};

/**
 * Whether an A2A request may carry integration overrides. A run pointed
 * elsewhere sends its tool calls (and their arguments) to that server and
 * takes its answers as tool results, so only an admin may start one, and only
 * for registered MCP integrations at an http(s) endpoint. `Some(reason)`
 * refuses the request.
 */
export const admitIntegrationOverrides = (
  body: Json,
  admission: OverrideAdmission,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const method = jsonString(body, 'method');
    if (method !== 'message/send' && method !== 'message/stream') return Option.none();
    const metadata = jsonProperty(jsonProperty(jsonProperty(body, 'params'), 'message'), 'metadata');
    const requested = requestedIntegrationOverrides(isJsonObject(metadata) ? metadata : undefined);
    if (Option.isNone(requested)) return Option.none();
    if (Option.isNone(requested.value)) {
      return Option.some(
        `${INTEGRATION_OVERRIDES_METADATA_KEY} must map integration slugs to { endpoint, bearerToken? }.`,
      );
    }

    if ((yield* admission.callerRole) !== 'admin') {
      return Option.some(`Only an admin may set ${INTEGRATION_OVERRIDES_METADATA_KEY}.`);
    }

    const listed = yield* Effect.result(admission.integrations);
    if (listed._tag === 'Failure') return Option.some(`The integrations could not be read: ${listed.failure.message}`);
    for (const [slug, override] of Object.entries(requested.value.value)) {
      const integration = listed.success.find((candidate) => candidate.slug === slug);
      if (integration === undefined) return Option.some(`No integration '${slug}' is registered.`);
      if (integration.kind !== 'mcp') {
        return Option.some(`'${slug}' is not an MCP integration; only MCP integrations can be pointed elsewhere.`);
      }
      if (!isHttpUrl(override.endpoint)) return Option.some(`The endpoint for '${slug}' must be an http(s) URL.`);
    }
    return Option.none();
  });

/** The admission for one HTTP request: its session's role, and the platform's integrations. */
export const requestAdmission = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | Context.Service.Identifier<typeof Auth>
      | Context.Service.Identifier<typeof AuthConfig>
      | Context.Service.Identifier<typeof IntegrationCatalog>
    >();
    const catalog = yield* IntegrationCatalog;
    const admission: OverrideAdmission = {
      callerRole: getSessionUser(request).pipe(
        Effect.map((user) => (user !== null && Predicate.isString(user.role) ? user.role : null)),
        Effect.provideContext(services),
      ),
      integrations: catalog.listIntegrations().pipe(Effect.map((listed) => listed.integrations)),
    };
    return admission;
  });
