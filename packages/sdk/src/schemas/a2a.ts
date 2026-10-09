import * as Schema from 'effect/Schema';
import { JsonObject } from './json';

/**
 * Schemas for the a2a payloads this SDK accepts over HTTP. The JSON-RPC
 * transport validates its own envelope inside `@a2a-js/sdk`, but the REST
 * transport hands the request body straight to the request handler — these
 * decode it first, so a malformed body fails at the edge with a parse error
 * instead of reaching the handler untyped.
 *
 * Arrays are mutable because the a2a interfaces declare them that way; a
 * decoded value is therefore assignable to `MessageSendParams` without a cast.
 */

const PartMetadata = Schema.optionalKey(JsonObject);

const TextPart = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
  metadata: PartMetadata,
});

const FileWithBytes = Schema.Struct({
  bytes: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const FileWithUri = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const FilePart = Schema.Struct({
  kind: Schema.Literal('file'),
  file: Schema.Union([FileWithBytes, FileWithUri]),
  metadata: PartMetadata,
});

const DataPart = Schema.Struct({
  kind: Schema.Literal('data'),
  data: JsonObject,
  metadata: PartMetadata,
});

export const A2APart = Schema.Union([TextPart, FilePart, DataPart]);

export const A2AMessage = Schema.Struct({
  kind: Schema.Literal('message'),
  messageId: Schema.String,
  role: Schema.Literals(['agent', 'user']),
  parts: Schema.mutable(Schema.Array(A2APart)),
  contextId: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
  referenceTaskIds: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  extensions: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  metadata: Schema.optionalKey(JsonObject),
});

export const A2APushNotificationConfig = Schema.Struct({
  url: Schema.String,
  id: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
  authentication: Schema.optionalKey(
    Schema.Struct({
      schemes: Schema.mutable(Schema.Array(Schema.String)),
      credentials: Schema.optionalKey(Schema.String),
    }),
  ),
});

export const A2AMessageSendConfiguration = Schema.Struct({
  acceptedOutputModes: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  blocking: Schema.optionalKey(Schema.Boolean),
  historyLength: Schema.optionalKey(Schema.Number),
  pushNotificationConfig: Schema.optionalKey(A2APushNotificationConfig),
});

export const A2AMessageSendParams = Schema.Struct({
  message: A2AMessage,
  configuration: Schema.optionalKey(A2AMessageSendConfiguration),
  metadata: Schema.optionalKey(JsonObject),
});

export const A2ASetPushNotificationConfigBody = Schema.Struct({
  pushNotificationConfig: A2APushNotificationConfig,
});

export type A2AMessageSendParams = typeof A2AMessageSendParams.Type;
export type A2APushNotificationConfig = typeof A2APushNotificationConfig.Type;
