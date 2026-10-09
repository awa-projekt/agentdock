import type { ToolAddress } from '@integragents/contracts';
import {
  type CatalogStore,
  type Integrations,
  InvalidInputError,
  InvocationError,
  type McpClient,
  McpError,
  type Tool,
} from '@integragents/host';
import type { IntegrationEndpointOverride, IntegrationOverrides } from 'agentdock-sdk/schemas';
import * as Context from 'effect/Context';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';

/**
 * The integrations service the gateway executes through, scoped to the run an
 * invocation belongs to:
 *
 * - **Endpoint overrides.** A run can point an MCP integration at another
 *   server (an eval case's own, a staging copy). Policy, approval and audit
 *   still run in the gateway; only where the call goes changes. The
 *   connection's stored credential is never sent to an overridden endpoint,
 *   only the override's own bearer token.
 * - **Retries.** A server that cannot be reached is tried again. A call that
 *   certainly never left (refused, unresolvable, no route, connect timeout,
 *   or a failure before the session sent `tools/call`) is retried for every
 *   tool; one that may have reached the server (connection reset, gateway
 *   5xx) only for read-only tools, which cannot have done anything twice.
 * - **Unreachable reporting.** A server still unreachable after the retries
 *   is recorded on the scope, so the caller can end the run instead of
 *   handing the model a tool error it would read as "no data".
 */

export type UnreachableIntegration = {
  readonly integration: string;
  readonly endpoint: string;
  readonly detail: string;
};

export type IntegrationCallScope = {
  readonly overrides: IntegrationOverrides;
  readonly unreachable: Ref.Ref<Option.Option<UnreachableIntegration>>;
};

/** The scope of the invocation in progress; outside one, no overrides and nobody listening. */
export const IntegrationCallScope = Context.Reference<IntegrationCallScope>(
  '@agentdock/api/gateway/IntegrationCallScope',
  { defaultValue: () => ({ overrides: {}, unreachable: Ref.makeUnsafe(Option.none()) }) },
);

export const openIntegrationCallScope = (overrides: IntegrationOverrides | undefined) =>
  Effect.map(Ref.make(Option.none<UnreachableIntegration>()), (unreachable) => ({
    overrides: overrides ?? {},
    unreachable,
  }));

/** Errors that mean the request was never sent: the connection did not even open. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Errors after the connection opened: the server may have received the request. */
const INTERRUPTED_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** A proxy or load balancer in front of a server that is down. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

/** How a call failed to reach its server, if it did. */
export type TransportFailure = 'not-sent' | 'interrupted';

const codeOf = (cause: unknown): string | undefined =>
  Predicate.hasProperty(cause, 'code') && Predicate.isString(cause.code) ? cause.code : undefined;

const statusOf = (cause: unknown): number | undefined => {
  const data = Predicate.hasProperty(cause, 'data') ? cause.data : undefined;
  return Predicate.hasProperty(data, 'status') && Predicate.isNumber(data.status) ? data.status : undefined;
};

/**
 * Whether an MCP failure was the server being out of reach, and whether the
 * call may have arrived anyway. An error the server answered with (unknown
 * tool, bad arguments, a failure it reports) is not a transport failure.
 */
export const transportFailure = (error: McpError): TransportFailure | undefined => {
  let found: TransportFailure | undefined;
  // Down the chain of `cause`s, and the MCP SDK's `data.cause`.
  let cause = error.cause;
  for (let depth = 0; depth < 10 && cause !== undefined && cause !== null; depth += 1) {
    const code = codeOf(cause);
    if (code !== undefined && NOT_SENT_CODES.has(code)) return 'not-sent';
    const status = statusOf(cause);
    if (
      (code !== undefined && INTERRUPTED_CODES.has(code)) ||
      (status !== undefined && UNAVAILABLE_STATUSES.has(status))
    ) {
      found = 'interrupted';
    }
    const data = Predicate.hasProperty(cause, 'data') ? cause.data : undefined;
    cause = Predicate.hasProperty(cause, 'cause')
      ? cause.cause
      : Predicate.hasProperty(data, 'cause')
        ? data.cause
        : undefined;
  }
  // The session connects and negotiates before it sends `tools/call`; a
  // failure there never sent the call.
  return found !== undefined && !error.detail.startsWith('tools/call ') ? 'not-sent' : found;
};

const isMcpError = Schema.is(McpError);

const retryable = (cause: unknown, readOnly: boolean): boolean => {
  if (!isMcpError(cause)) return false;
  const failure = transportFailure(cause);
  return failure === 'not-sent' || (failure === 'interrupted' && readOnly);
};

const McpEnvelope = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Json)),
  structuredContent: Schema.optional(Schema.Json),
  isError: Schema.optional(Schema.Boolean),
});
const decodeEnvelope = Schema.decodeUnknownOption(McpEnvelope);
const TextContent = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String });
const decodeText = Schema.decodeUnknownOption(TextContent);
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * An MCP tool result as the tool's answer. Unlike the host's normalization,
 * content blocks other than text (images, audio, resources) are kept even when
 * the server also sent `structuredContent`, so the model gets to see them; the
 * structured content then follows as a text block.
 */
export const mcpToolResult = (tool: string, raw: Schema.Json): Effect.Effect<Schema.Json, InvocationError> => {
  const envelope = Option.getOrUndefined(decodeEnvelope(raw));
  if (envelope === undefined) return Effect.succeed(raw);
  const content = envelope.content ?? [];
  const texts = content.flatMap((block) => Option.toArray(decodeText(block)).map((text) => text.text));
  if (envelope.isError === true) {
    return Effect.fail(
      new InvocationError({ code: 'tool_error', detail: texts.join('\n') || `${tool} reported an error` }),
    );
  }
  if (texts.length < content.length) {
    // Media stays; structured content joins it as text, unless a text block already carries it.
    const structured = envelope.structuredContent;
    if (structured === undefined) return Effect.succeed(content);
    const serialized = JSON.stringify(structured);
    const carried = texts.some((text) =>
      Option.match(decodeJsonText(text), {
        onNone: () => false,
        onSome: (value) => JSON.stringify(value) === serialized,
      }),
    );
    return Effect.succeed(carried ? content : [...content, { type: 'text', text: serialized }]);
  }
  if (envelope.structuredContent !== undefined) return Effect.succeed(envelope.structuredContent);
  const [only] = texts;
  if (texts.length === 1 && only !== undefined)
    return Effect.succeed(Option.getOrElse(decodeJsonText(only), () => only));
  return Effect.succeed(content.length > 0 ? content : raw);
};

type HostIntegrations = Integrations['Service'];

/** What the wrapper uses of the host: its own `execute` for calls that stay on the registered endpoint. */
type ExecutingHost = { readonly execute: HostIntegrations['execute'] };

export type RunScopedIntegrationsOptions<Host extends ExecutingHost> = {
  readonly host: Host;
  readonly store: Pick<CatalogStore['Service'], 'findTool'>;
  readonly mcp: Pick<McpClient['Service'], 'callTool'>;
  /** How often an unreachable server is tried again; 3 by default. */
  readonly retries?: number;
  /** The first wait between attempts, doubling after each; 500 ms by default. */
  readonly retryDelay?: Duration.Input;
};

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = '500 millis';

const callOverridden = (
  mcp: Pick<McpClient['Service'], 'callTool'>,
  tool: Tool,
  override: IntegrationEndpointOverride,
  input: Schema.Json,
) => {
  if (tool.call.kind !== 'mcp') {
    return Effect.fail(
      new InvalidInputError({
        field: 'integration',
        detail: `${tool.integration} is not an MCP integration; only MCP integrations can be pointed elsewhere for a run`,
      }),
    );
  }
  const credential = Option.fromNullishOr(override.bearerToken).pipe(
    Option.map((token) => ({ headerName: 'Authorization', headerValue: `Bearer ${token}` })),
  );
  return mcp
    .callTool({ endpoint: override.endpoint, era: Option.none() }, credential, tool.call.tool, input)
    .pipe(Effect.flatMap((raw) => mcpToolResult(tool.name, raw)));
};

/** The host's integrations, executing through the invocation's {@link IntegrationCallScope}. */
export const runScopedIntegrations = <Host extends ExecutingHost>(
  options: RunScopedIntegrationsOptions<Host>,
): Host => {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const schedule = Schedule.exponential(options.retryDelay ?? DEFAULT_RETRY_DELAY).pipe(Schedule.jittered);
  const execute: HostIntegrations['execute'] = (address: ToolAddress, input) =>
    Effect.gen(function* () {
      const scope = yield* IntegrationCallScope;
      const tool = Option.getOrUndefined(yield* options.store.findTool(address));
      const override = tool === undefined ? undefined : scope.overrides[tool.integration];
      // Suspended, so every retry makes the call again.
      const attempt = Effect.suspend(() =>
        tool === undefined || override === undefined
          ? options.host.execute(address, input)
          : callOverridden(options.mcp, tool, override, input),
      );
      return yield* attempt.pipe(
        Effect.retry({ times: retries, schedule, while: (error) => retryable(error, tool?.readOnly ?? false) }),
        Effect.tapError((error) =>
          isMcpError(error) && transportFailure(error) !== undefined && tool !== undefined
            ? Ref.set(
                scope.unreachable,
                Option.some({ integration: tool.integration, endpoint: error.endpoint, detail: error.detail }),
              )
            : Effect.void,
        ),
      );
    });
  return { ...options.host, execute };
};
