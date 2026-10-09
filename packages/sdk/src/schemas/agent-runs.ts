import * as Schema from 'effect/Schema';
import { JsonObject } from './json';

/**
 * Own schema types for agent-run persistence — deliberately not the @a2a-js
 * `Task`/`Message`/`Part` types, so the SDK's runtime doesn't depend on a
 * specific transport protocol. `packages/sdk/src/a2a/run-record.ts` holds the
 * boundary transforms to/from a2a `Task` shapes.
 */

export const AgentRunTextPart = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
});

export const AgentRunDataPart = Schema.Struct({
  kind: Schema.Literal('data'),
  data: JsonObject,
});

export const AgentRunFileContent = Schema.Union([
  Schema.Struct({
    name: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
    bytes: Schema.String,
  }),
  Schema.Struct({
    name: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
    uri: Schema.String,
  }),
]);

export const AgentRunFilePart = Schema.Struct({
  kind: Schema.Literal('file'),
  file: AgentRunFileContent,
});

export const AgentRunPart = Schema.Union([AgentRunTextPart, AgentRunDataPart, AgentRunFilePart]);

export const AgentRunMessage = Schema.Struct({
  role: Schema.Literals(['user', 'agent']),
  messageId: Schema.String,
  parts: Schema.Array(AgentRunPart),
  metadata: Schema.optional(JsonObject),
});

export const AgentRunArtifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optional(Schema.String),
  parts: Schema.Array(AgentRunPart),
});

export const AgentRunStatusState = Schema.Literals([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

export const AgentRunStatus = Schema.Struct({
  state: AgentRunStatusState,
  timestamp: Schema.String,
  message: Schema.optional(AgentRunMessage),
});

export const AgentRunStatusHistoryEntry = Schema.Struct({
  state: AgentRunStatusState,
  timestamp: Schema.String,
});

/**
 * Links a run back to where it was invoked from. Protocol surfaces remain
 * distinct so one adapter cannot masquerade as another. `workflow` origin is what
 * lets a workflow run's internal agent calls be inspected individually — the
 * whole reason `AgentRunStore` exists as a general (not a2a-only) store.
 */
export const AgentRunOrigin = Schema.Union([
  Schema.Struct({ surface: Schema.Literal('a2a') }),
  Schema.Struct({ surface: Schema.Literal('ag-ui') }),
  Schema.Struct({ surface: Schema.Literal('sdk') }),
  /** A trial of an eval run; the trial records the run id. */
  Schema.Struct({ surface: Schema.Literal('eval') }),
  /** A subagent run started by another agent's `send_task` call. */
  Schema.Struct({ surface: Schema.Literal('delegation'), parentTaskId: Schema.String }),
  Schema.Struct({
    surface: Schema.Literal('workflow'),
    workflowId: Schema.String,
    workflowRunId: Schema.String,
    stepId: Schema.String,
    attempt: Schema.Number,
  }),
]);

export const AgentRunRecord = Schema.Struct({
  id: Schema.String,
  contextId: Schema.String,
  agentId: Schema.String,
  status: AgentRunStatus,
  statusHistory: Schema.optional(Schema.Array(AgentRunStatusHistoryEntry)),
  history: Schema.Array(AgentRunMessage),
  artifacts: Schema.Array(AgentRunArtifact),
  origin: AgentRunOrigin,
  metadata: Schema.optional(JsonObject),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const AgentRunRecordList = Schema.Array(AgentRunRecord);

/** HTTP response for listing a workflow run's individual agent-node invocations. */
export const AgentRunsResponse = Schema.Struct({
  agentRuns: Schema.Array(AgentRunRecord),
});

export type AgentRunTextPart = Schema.Schema.Type<typeof AgentRunTextPart>;
export type AgentRunDataPart = Schema.Schema.Type<typeof AgentRunDataPart>;
export type AgentRunFileContent = Schema.Schema.Type<typeof AgentRunFileContent>;
export type AgentRunFilePart = Schema.Schema.Type<typeof AgentRunFilePart>;
export type AgentRunPart = Schema.Schema.Type<typeof AgentRunPart>;
export type AgentRunMessage = Schema.Schema.Type<typeof AgentRunMessage>;
export type AgentRunArtifact = Schema.Schema.Type<typeof AgentRunArtifact>;
export type AgentRunStatusState = Schema.Schema.Type<typeof AgentRunStatusState>;
export type AgentRunStatus = Schema.Schema.Type<typeof AgentRunStatus>;
export type AgentRunStatusHistoryEntry = Schema.Schema.Type<typeof AgentRunStatusHistoryEntry>;
export type AgentRunOrigin = Schema.Schema.Type<typeof AgentRunOrigin>;
export type AgentRunRecord = Schema.Schema.Type<typeof AgentRunRecord>;
export type AgentRunRecordList = Schema.Schema.Type<typeof AgentRunRecordList>;
export type AgentRunsResponse = Schema.Schema.Type<typeof AgentRunsResponse>;
