import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { ExecutorOperationError } from '../executor/schemas';
import { AgentExecutorRegistry } from '../executor/service';
import { withHttpRootSpan } from '../tracing';

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;
const operationError = (fallback: string) => (error: unknown) =>
  Effect.fail(new ExecutorOperationError({ message: toErrorMessage(error, fallback) }));

export const executorHandler = HttpApiBuilder.group(AgentdockApi, 'agentExecutor', (handlers) =>
  handlers
    .handle('listExecutorSources', ({ params }) =>
      AgentExecutorRegistry.use((registry) => registry.listSources(params.agentId)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.sources.list'),
        Effect.catch(operationError('Failed to list executor sources')),
      ),
    )
    .handle('detectSource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.detectSource(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.sources.detect'),
        Effect.catch(operationError('Failed to detect source')),
      ),
    )
    .handle('probeMcpEndpoint', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.probeMcpEndpoint(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.mcp.probe'),
      ),
    )
    .handle('addMcpSource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.addMcpSource(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.mcp.sources.add'),
        Effect.catch(operationError('Failed to add MCP source')),
      ),
    )
    .handle('updateMcpSource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.updateMcpSource(params.agentId, params.sourceId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.mcp.sources.update'),
        Effect.catch(operationError('Failed to update MCP source')),
      ),
    )
    .handle('removeMcpSource', ({ params }) =>
      AgentExecutorRegistry.use((registry) => registry.removeMcpSource(params.agentId, params.sourceId)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.mcp.sources.remove'),
        Effect.catch(operationError('Failed to remove MCP source')),
      ),
    )
    .handle('previewOpenApiSpec', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.previewOpenApiSpec(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.openapi.preview'),
        Effect.catch(operationError('Failed to preview OpenAPI spec')),
      ),
    )
    .handle('addOpenApiSource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.addOpenApiSource(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.openapi.sources.add'),
        Effect.catch(operationError('Failed to add OpenAPI source')),
      ),
    )
    .handle('addGraphqlSource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.addGraphqlSource(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.graphql.sources.add'),
        Effect.catch(operationError('Failed to add GraphQL source')),
      ),
    )
    .handle('probeGoogleDiscovery', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.probeGoogleDiscovery(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.google_discovery.probe'),
        Effect.catch(operationError('Failed to probe Google Discovery source')),
      ),
    )
    .handle('addGoogleDiscoverySource', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.addGoogleDiscoverySource(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.google_discovery.sources.add'),
        Effect.catch(operationError('Failed to add Google Discovery source')),
      ),
    )
    .handle('removeExecutorSource', ({ params }) =>
      AgentExecutorRegistry.use((registry) => registry.removeExecutorSource(params.agentId, params.sourceId)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.sources.remove'),
        Effect.catch(operationError('Failed to remove executor source')),
      ),
    )
    .handle('setPinnedExecutorTools', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.setPinnedTools(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.pinned_tools.set'),
        Effect.catch(operationError('Failed to update pinned executor tools')),
      ),
    )
    .handle('setExecutorToolModes', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.setToolModes(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.tool_modes.set'),
        Effect.catch(operationError('Failed to update executor tool modes')),
      ),
    )
    .handle('startExecutorOAuth', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.startOAuth(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.oauth.start'),
        Effect.catch(operationError('Failed to start OAuth')),
      ),
    )
    .handle('completeExecutorOAuth', ({ params, payload }) =>
      AgentExecutorRegistry.use((registry) => registry.completeOAuth(params.agentId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.executor.oauth.complete'),
        Effect.catch(operationError('Failed to complete OAuth')),
      ),
    ),
);
