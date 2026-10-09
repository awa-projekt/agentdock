import * as Schema from 'effect/Schema';
import { Json, JsonObject } from './json';
import { NonNegativeInt, Usage } from './usage';

export const SessionId = Schema.String.pipe(Schema.brand('SessionId'));
export type SessionId = typeof SessionId.Type;
export const BranchId = Schema.String.pipe(Schema.brand('BranchId'));
export type BranchId = typeof BranchId.Type;
export const ContextId = Schema.String.pipe(Schema.brand('ContextId'));
export type ContextId = typeof ContextId.Type;
export const TaskId = Schema.String.pipe(Schema.brand('TaskId'));
export type TaskId = typeof TaskId.Type;
export const MessageId = Schema.String.pipe(Schema.brand('MessageId'));
export type MessageId = typeof MessageId.Type;
export const TargetId = Schema.String.pipe(Schema.brand('TargetId'));
export type TargetId = typeof TargetId.Type;

export const Millis = NonNegativeInt.pipe(Schema.brand('Millis'));
export type Millis = typeof Millis.Type;

export const Metadata = JsonObject;
export type Metadata = typeof Metadata.Type;

export class SessionTarget extends Schema.Class<SessionTarget>('SessionTarget')({
  kind: Schema.Literals(['agent', 'workflow']),
  id: TargetId,
  name: Schema.String,
}) {}

export class SessionTime extends Schema.Class<SessionTime>('SessionTime')({
  createdAt: Millis,
  updatedAt: Millis,
  archivedAt: Schema.optional(Millis),
}) {}

export class SessionSummary extends Schema.Class<SessionSummary>('SessionSummary')({
  initialMessage: Schema.String,
  outcomeText: Schema.String,
  messageCount: NonNegativeInt,
  taskCount: NonNegativeInt,
  actionCount: NonNegativeInt,
}) {}

export class AppSession extends Schema.Class<AppSession>('Session')({
  id: SessionId,
  parentSessionId: Schema.optional(SessionId),
  activeBranchId: BranchId,
  target: SessionTarget,
  title: Schema.String,
  slug: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  usage: Schema.optional(Usage),
  summary: Schema.optional(SessionSummary),
  time: SessionTime,
}) {}

export class BranchForkPoint extends Schema.Class<BranchForkPoint>('BranchForkPoint')({
  parentBranchId: BranchId,
  messageId: Schema.optional(MessageId),
  taskId: Schema.optional(TaskId),
  messageIndex: NonNegativeInt,
}) {}

export class SessionBranch extends Schema.Class<SessionBranch>('SessionBranch')({
  id: BranchId,
  sessionId: SessionId,
  contextId: ContextId,
  parentBranchId: Schema.optional(BranchId),
  forkPoint: Schema.optional(BranchForkPoint),
  origin: Schema.Literals(['initial', 'edit-message', 'regenerate', 'fork-session']),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  time: SessionTime,
}) {}

export const SessionMessageEvent = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.String),
  rawEvent: Schema.optional(Json),
  at: Schema.Number,
});

export const SessionMessageStatusHistoryEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  at: Schema.Number,
});

export const SessionMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
  /** Humanized terminal state of the task this message belongs to (e.g. "Completed"). */
  status: Schema.optional(Schema.String),
  statusHistory: Schema.optional(Schema.Array(SessionMessageStatusHistoryEntry)),
  parts: Schema.optional(Schema.Array(Json)),
  events: Schema.optional(Schema.Array(SessionMessageEvent)),
  createdAt: Schema.optional(Schema.Number),
});

export const Session = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  branchId: Schema.optional(Schema.String),
  messages: Schema.Array(SessionMessage),
  conversationState: Schema.Struct({
    contextId: Schema.String,
    taskId: Schema.optional(Schema.String),
  }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SessionsResponse = Schema.Struct({
  sessions: Schema.Array(Session),
});

export const EvalTarget = Schema.Struct({
  kind: Schema.Literals(['agent', 'workflow', 'unknown']),
  id: Schema.String,
  name: Schema.String,
});

export const EvalToolAction = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  input: Schema.optional(Json),
  output: Schema.optional(Json),
  error: Schema.optional(Schema.String),
});

export const EvalMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  parts: Schema.Array(Json),
  createdAt: Schema.optional(Schema.Number),
});

export const EvalOutcome = Schema.Struct({
  state: Schema.optional(Schema.String),
  text: Schema.String,
  actions: Schema.Array(EvalToolAction),
});

export const EvalSessionSummary = Schema.Struct({
  id: Schema.String,
  target: EvalTarget,
  title: Schema.String,
  initialMessage: Schema.String,
  outcome: EvalOutcome,
  messageCount: Schema.Number,
  actionCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalSessionDetail = Schema.Struct({
  id: Schema.String,
  target: EvalTarget,
  title: Schema.String,
  initialMessage: Schema.String,
  messages: Schema.Array(EvalMessage),
  outcome: EvalOutcome,
  messageCount: Schema.Number,
  actionCount: Schema.Number,
  task: Schema.optional(Json),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const EvalSessionsResponse = Schema.Struct({
  sessions: Schema.Array(EvalSessionSummary),
});

export const DeleteSessionResponse = Schema.Struct({
  deleted: Schema.Boolean,
});

export class SessionOperationError extends Schema.TaggedError<SessionOperationError>()(
  'SessionOperationError',
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export type Session = Schema.Schema.Type<typeof Session>;
export type SessionMessageEvent = Schema.Schema.Type<typeof SessionMessageEvent>;
export type SessionMessage = Schema.Schema.Type<typeof SessionMessage>;
export type SessionsResponse = Schema.Schema.Type<typeof SessionsResponse>;
export type DeleteSessionResponse = Schema.Schema.Type<typeof DeleteSessionResponse>;
export type EvalTarget = Schema.Schema.Type<typeof EvalTarget>;
export type EvalToolAction = Schema.Schema.Type<typeof EvalToolAction>;
export type EvalMessage = Schema.Schema.Type<typeof EvalMessage>;
export type EvalOutcome = Schema.Schema.Type<typeof EvalOutcome>;
export type EvalSessionSummary = Schema.Schema.Type<typeof EvalSessionSummary>;
export type EvalSessionDetail = Schema.Schema.Type<typeof EvalSessionDetail>;
export type EvalSessionsResponse = Schema.Schema.Type<typeof EvalSessionsResponse>;
