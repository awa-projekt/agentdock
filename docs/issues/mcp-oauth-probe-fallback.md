# MCP OAuth Probe Fallback

## Summary

`https://mcp.linear.app/mcp` is reachable and is a valid OAuth-protected MCP endpoint, but our `/agents/:agentId/executor/mcp/probe` wrapper route returned executor's generic unreachable message:

```txt
Couldn't reach this URL. Check the address, your network, and that the server is running.
```

Executor's direct probe succeeds in this repo, and executor web also works with the same Linear endpoint. The divergence appears to be in our API wrapper/runtime path around executor, not in Linear or executor's MCP plugin generally.

## Observed Behavior

- Raw `curl` to `https://mcp.linear.app/mcp` returns `401` with `WWW-Authenticate: Bearer ... resource_metadata=...`, which is the expected MCP OAuth challenge.
- Direct `executor.mcp.probeEndpoint("https://mcp.linear.app/mcp")` succeeds and returns `requiresOAuth: true` and `supportsDynamicRegistration: true`.
- Direct `AgentExecutorRegistry.probeMcpEndpoint(...)` outside the HTTP server succeeds.
- The running HTTP route `POST /agents/:agentId/executor/mcp/probe` returned `400` with the generic unreachable message.
- Public unauthenticated MCP endpoints like Context7 succeed through the same HTTP route.

## Likely Cause

Executor's MCP plugin runs a shape probe after unauthenticated tool discovery fails. For OAuth-protected MCP, a `401 Bearer` response should classify as MCP with required OAuth.

In our HTTP route runtime, the plugin's shape probe appears to hit a transport-level failure before it can classify Linear's `401` response. Executor maps that swallowed boundary failure to `kind: "unreachable"`, which becomes the generic user-facing message.

We have not captured the original low-level `client.execute` cause yet. The current logs only show the final `400` response.

## Current Fallback

`packages/api/src/executor/service.ts` now has a narrow fallback around `executor.mcp.probeEndpoint`:

- Try executor's MCP probe first.
- If it fails, send a direct MCP `initialize` POST with platform `fetch`.
- If the response is `401 Bearer` with `resource_metadata` or `error`, classify it as OAuth-protected MCP.
- Use `executor.oauth.probe` to read OAuth metadata and return the normal probe shape.

This keeps auth flow delegated to executor and only fills the probe classification gap at our wrapper boundary.

## Follow-Up

- Instrument executor's `ProbeTransportError` boundary cause inside the HTTP route path.
- Compare runtime services available in executor web's plugin route vs our `HttpApiBuilder` route.
- Check whether our server runtime, OpenTelemetry layer, or nested Effect HTTP client context affects `FetchHttpClient` during OAuth-protected probe responses.
- Remove the fallback if the underlying route/runtime divergence is fixed upstream or in our composition.
