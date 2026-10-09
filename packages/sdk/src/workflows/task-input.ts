import { type Schema as JsonSchema, Validator } from '@cfworker/json-schema';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { InputContract, Json, JsonSerializableObject } from '../schemas';
import { isJsonArray, isJsonString, JsonObject } from '../schemas';

const JSON_MEDIA_TYPE = 'application/json';
const TEXT_MEDIA_TYPE = 'text/plain';
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

type JsonSchemaObject = JsonSchema & Schema.Schema.Type<typeof JsonObject>;

export type WorkflowInputMode = 'none' | 'text' | 'data' | 'file';

export type WorkflowInputPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'data'; readonly data: Json }
  | {
      readonly kind: 'file';
      readonly file: {
        readonly name?: string | undefined;
        readonly mimeType?: string | undefined;
        readonly uri?: string | undefined;
        readonly bytes?: string | undefined;
      };
    };

type WorkflowFileInputPart = Extract<WorkflowInputPart, { readonly kind: 'file' }>;
type WorkflowDataInputPart = Extract<WorkflowInputPart, { readonly kind: 'data' }>;

const decodeSchemaText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));

export const parseInputContractSchema = (contract: InputContract | undefined): JsonSchemaObject | undefined => {
  const rawSchema = contract?.schema.trim();
  if (!rawSchema) return undefined;
  return Option.getOrUndefined(decodeSchemaText(rawSchema));
};

const schemaTypes = (schema: JsonSchemaObject | undefined): ReadonlyArray<string> => {
  const type = schema?.type;
  if (isJsonArray(type)) return type.flatMap((entry) => (isJsonString(entry) ? [entry] : []));
  return isJsonString(type) ? [type] : [];
};

const schemaContentMediaType = (schema: JsonSchemaObject | undefined): string | undefined => {
  const mediaType = schema?.contentMediaType;
  return isJsonString(mediaType) && mediaType.trim() ? mediaType.trim() : undefined;
};

export const workflowInputMode = (contract: InputContract | undefined): WorkflowInputMode => {
  const schema = parseInputContractSchema(contract);
  if (!schema) return 'none';
  if (schemaContentMediaType(schema)) return 'file';
  const types = schemaTypes(schema);
  return types.length === 1 && types[0] === 'string' ? 'text' : 'data';
};

const mimeTypeMatches = (accepted: string, actual: string): boolean =>
  accepted === '*/*' || accepted === actual || (accepted.endsWith('/*') && actual.startsWith(accepted.slice(0, -1)));

const filePartIssues = (schema: JsonSchemaObject, part: WorkflowFileInputPart): ReadonlyArray<string> => {
  const accepted = schemaContentMediaType(schema);
  if (!accepted) return [];
  const actual = part.file.mimeType;
  if (!actual) return [`file is missing a mime type; accepted: ${accepted}`];
  return mimeTypeMatches(accepted, actual) ? [] : [`file type '${actual}' is not accepted; accepted: ${accepted}`];
};

const validateJsonValue = (schema: JsonSchemaObject, value: Json): ReadonlyArray<string> => {
  const result = new Validator(schema, '2020-12', false).validate(value);
  return result.valid ? [] : result.errors.map((error) => `${error.instanceLocation}: ${error.error}`);
};

/**
 * Check transport-neutral input parts against a workflow's structured input
 * contract. A missing contract accepts any task.
 */
export const validateTaskInput = (
  contract: InputContract | undefined,
  parts: ReadonlyArray<WorkflowInputPart>,
): ReadonlyArray<string> => {
  if (!contract?.schema.trim()) return [];
  const schema = parseInputContractSchema(contract);
  if (!schema) return ["the workflow's input schema is not valid JSON"];

  const mode = workflowInputMode(contract);
  if (mode === 'text') {
    const textParts = parts.filter((part) => part.kind === 'text');
    if (textParts.length === 0) return ['missing required input: a text part'];
    const unsupported = parts.filter((part) => part.kind !== 'text');
    if (unsupported.length > 0)
      return unsupported.map((part) => `${part.kind} parts are not accepted; this workflow accepts: text`);
    return validateJsonValue(schema, textParts.map((part) => part.text).join('\n'));
  }

  if (mode === 'file') {
    const fileParts = parts.filter((part): part is WorkflowFileInputPart => part.kind === 'file');
    if (fileParts.length === 0) return ['missing required input: a file part'];
    const unsupported = parts.filter((part) => part.kind !== 'file');
    if (unsupported.length > 0)
      return unsupported.map((part) => `${part.kind} parts are not accepted; this workflow accepts: file`);
    return filePartIssues(schema, fileParts[0]!);
  }

  const dataParts = parts.filter((part): part is WorkflowDataInputPart => part.kind === 'data');
  if (dataParts.length === 0) return ['missing required input: a data part'];
  const unsupported = parts.filter((part) => part.kind !== 'data');
  if (unsupported.length > 0)
    return unsupported.map((part) => `${part.kind} parts are not accepted; this workflow accepts: data`);
  const value = dataParts.length === 1 ? dataParts[0]!.data : dataParts.map((part) => part.data);
  return validateJsonValue(schema, value);
};

/** File bytes are intentionally dropped: node outputs are persisted as run events. */
const fileSummary = (part: WorkflowFileInputPart): JsonSerializableObject => ({
  name: part.file.name,
  mimeType: part.file.mimeType,
  uri: part.file.uri,
});

const textFromParts = (parts: ReadonlyArray<WorkflowInputPart>): string =>
  parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');

const dataFromParts = (parts: ReadonlyArray<WorkflowInputPart>): string => {
  const data = parts.flatMap((part) => (part.kind === 'data' ? [part.data] : []));
  return data.length === 0 ? '' : JSON.stringify(data.length === 1 ? data[0] : data);
};

export const workflowInputFromParts = (
  contract: InputContract | undefined,
  parts: ReadonlyArray<WorkflowInputPart>,
): string => {
  const mode = workflowInputMode(contract);
  // No declared contract still forwards whatever the task carried. Dropping it
  // would leave the entrypoint silently receiving nothing, which is a far worse
  // failure than passing along an unvalidated payload the workflow can inspect.
  if (mode === 'none') return dataFromParts(parts) || textFromParts(parts);
  if (mode === 'text') return textFromParts(parts);
  if (mode === 'file') {
    const files = parts.flatMap((part) => (part.kind === 'file' ? [fileSummary(part)] : []));
    return JSON.stringify(files.length === 1 ? files[0] : files);
  }

  const data = parts.flatMap((part) => (part.kind === 'data' ? [part.data] : []));
  return data.length === 0 ? '' : JSON.stringify(data.length === 1 ? data[0] : data);
};

/** Media types for a target's agent card, derived from its input contract. */
export const inputContractMediaTypes = (contract: InputContract | undefined): ReadonlyArray<string> => {
  const schema = parseInputContractSchema(contract);
  if (!schema) return [TEXT_MEDIA_TYPE];
  const mediaType = schemaContentMediaType(schema);
  if (mediaType) return [mediaType || OCTET_STREAM_MEDIA_TYPE];
  return workflowInputMode(contract) === 'text' ? [TEXT_MEDIA_TYPE] : [JSON_MEDIA_TYPE];
};
