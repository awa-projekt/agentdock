import * as Schema from 'effect/Schema';

export const McpAuthorizationRequestId = Schema.String.pipe(Schema.brand('McpAuthorizationRequestId'));
export const McpGrantId = Schema.String.pipe(Schema.brand('McpGrantId'));

/**
 * How an MCP client came to be known: registered itself dynamically (RFC 7591)
 * or identified by the URL of its published client metadata document.
 */
export const McpClientKind = Schema.Literals(['dcr', 'cimd']);

/** What the consent page shows about an MCP client asking to act as the signed-in person. */
export const McpAuthorizationRequestView = Schema.Struct({
  id: McpAuthorizationRequestId,
  clientName: Schema.String,
  clientId: Schema.String,
  clientKind: McpClientKind,
  redirectOrigin: Schema.String,
});

export const McpAuthorizationDecision = Schema.Struct({
  approve: Schema.Boolean,
});

/** Where the browser goes next: the client's redirect URI carrying a code or an error. */
export const McpAuthorizationRedirect = Schema.Struct({
  redirect: Schema.String,
});

export const McpGrantView = Schema.Struct({
  id: McpGrantId,
  clientName: Schema.String,
  clientId: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
});

/** How an external coding agent reaches this instance, and the MCP clients the signed-in person has authorized. */
export const McpAccessResponse = Schema.Struct({
  mcpUrl: Schema.String,
  skillsUrl: Schema.String,
  grants: Schema.Array(McpGrantView),
});

export const RevokeMcpGrantResponse = Schema.Struct({
  revoked: Schema.Boolean,
});

export class McpAccessError extends Schema.TaggedError<McpAccessError>()(
  'McpAccessError',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class McpAccessNotFoundError extends Schema.TaggedError<McpAccessNotFoundError>()(
  'McpAccessNotFoundError',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export type McpAuthorizationRequestId = typeof McpAuthorizationRequestId.Type;
export type McpGrantId = typeof McpGrantId.Type;
export type McpClientKind = typeof McpClientKind.Type;
export type McpAuthorizationRequestView = typeof McpAuthorizationRequestView.Type;
export type McpAuthorizationDecision = typeof McpAuthorizationDecision.Type;
export type McpAuthorizationRedirect = typeof McpAuthorizationRedirect.Type;
export type McpGrantView = typeof McpGrantView.Type;
export type McpAccessResponse = typeof McpAccessResponse.Type;
export type RevokeMcpGrantResponse = typeof RevokeMcpGrantResponse.Type;
