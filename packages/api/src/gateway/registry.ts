import {
  type IntegrationRegistrySurface,
  type SearchIntegrationRegistryInput,
  type SearchIntegrationRegistryResponse,
} from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { getJson } from '../http-client';
import { operationError } from './errors';

const REGISTRY_URL = 'https://integrations.sh';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

const RegistrySurface = Schema.Struct({
  kind: Schema.Literals(['mcp', 'openapi', 'graphql', 'cli']),
  slug: Schema.String,
  url: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  auth: Schema.optional(
    Schema.Struct({
      kind: Schema.String,
      note: Schema.optional(Schema.String),
    }),
  ),
});

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      domain: Schema.String,
      name: Schema.String,
      description: Schema.String,
      kinds: Schema.Array(Schema.Literals(['mcp', 'openapi', 'graphql', 'cli'])),
      url: Schema.String,
      surfaces: Schema.Array(RegistrySurface),
    }),
  ),
});

const decodeRegistrySearchResponse = Schema.decodeUnknownEffect(RegistrySearchResponse);

const installableSurface = (surface: typeof RegistrySurface.Type): IntegrationRegistrySurface | null => {
  if ((surface.kind !== 'mcp' && surface.kind !== 'openapi') || surface.url === undefined) return null;
  return {
    kind: surface.kind,
    slug: surface.slug,
    url: surface.url,
    icon: surface.icon,
    authKind: surface.auth?.kind,
    authNote: surface.auth?.note,
  };
};

export const searchIntegrationRegistry = Effect.fn('IntegrationRegistry.search')(function* (
  input: SearchIntegrationRegistryInput,
) {
  const query = input.query.trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)));
  const url = new URL('/api/search', REGISTRY_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  if (input.kind !== undefined) url.searchParams.set('kind', input.kind);

  const response = yield* getJson(url.toString()).pipe(
    Effect.flatMap(decodeRegistrySearchResponse),
    Effect.mapError(operationError),
  );

  return {
    query,
    results: response.results.map((result) => ({
      domain: result.domain,
      name: result.name,
      description: result.description,
      kinds: result.kinds,
      registryUrl: result.url,
      surfaces: result.surfaces.flatMap((surface) => {
        const installable = installableSurface(surface);
        return installable === null ? [] : [installable];
      }),
    })),
  } satisfies SearchIntegrationRegistryResponse;
});
