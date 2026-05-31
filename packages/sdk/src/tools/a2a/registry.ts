import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { Effect } from 'effect';
import { type A2aAgentRegistry } from './operations';

type AgentRegistryEntry = {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly a2aUrl?: string;
};

type AgentRegistryResponse = ReadonlyArray<AgentRegistryEntry>;

export type CreateHttpAgentRegistryOptions = {
  readonly baseUrl: string;
  readonly sourceAgentId?: string;
  readonly fetchImpl?: typeof fetch;
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/, '');

const defaultRegistryBaseUrl = (): string => process.env.AGENTDOCK_API_URL ?? 'http://127.0.0.1:38123';

const normalizeA2aAgentUrl = (url: string): string => {
  const normalized = normalizeBaseUrl(url);
  const agentCardSuffix = `/${AGENT_CARD_PATH}`;

  return normalized.endsWith(agentCardSuffix) ? normalized.slice(0, -agentCardSuffix.length) : normalized;
};

export const createHttpAgentRegistry = ({
  baseUrl,
  sourceAgentId,
  fetchImpl = fetch,
}: CreateHttpAgentRegistryOptions): A2aAgentRegistry => ({
  list: async () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const path = sourceAgentId ? `/agents/${sourceAgentId}/allowed-targets` : '/agents';
        yield* Effect.annotateCurrentSpan({
          'http.url': `${normalizeBaseUrl(baseUrl)}${path}`,
          'registry.base_url': normalizeBaseUrl(baseUrl),
          'a2a.source_agent.id': sourceAgentId ?? 'external',
        });
        const response = yield* Effect.promise(() => fetchImpl(`${normalizeBaseUrl(baseUrl)}${path}`)).pipe(
          Effect.withSpan('agentdock.registry.fetch'),
        );

        if (!response.ok) {
          throw new Error(`Failed to list agents from registry: ${response.status} ${response.statusText}`);
        }

        yield* Effect.annotateCurrentSpan({ 'http.response.status_code': response.status });
        const agents = (yield* Effect.promise(() => response.json())) as AgentRegistryResponse;
        yield* Effect.annotateCurrentSpan({ 'agent.count': agents.length });

        return agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          url: normalizeA2aAgentUrl(agent.a2aUrl ?? agent.url ?? `${normalizeBaseUrl(baseUrl)}/agents/${agent.id}/a2a`),
        }));
      }).pipe(Effect.withSpan('agentdock.registry.list_agents')),
    ),
});

export const createStaticAgentRegistry = (
  agents: ReadonlyArray<{ readonly id: string; readonly name: string; readonly url: string }>,
): A2aAgentRegistry => ({
  list: async () => agents,
});

export const defaultA2aAgentRegistry = createHttpAgentRegistry({
  baseUrl: defaultRegistryBaseUrl(),
});
