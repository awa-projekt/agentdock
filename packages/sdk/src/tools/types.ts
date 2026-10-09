import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import { z } from 'zod';
import { coerceJson, type Json, type JsonObject, type JsonSerializable } from '../schemas/json';

/**
 * Thrown by a tool when its failure must end the run rather than be answered
 * to the model, e.g. an integration still unreachable after its retries: the
 * model would carry on without the data and report nothing, or invent it.
 */
export class ToolRunFailure extends Schema.TaggedError<ToolRunFailure>()('ToolRunFailure', {
  message: Schema.String,
}) {}

export const isToolRunFailure = (cause: unknown): cause is ToolRunFailure =>
  Predicate.isTagged(cause, 'ToolRunFailure');

export type AgentTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing the `invoke` input. */
  readonly parameters: JsonObject;

  readonly schema?: z.ZodType;
  readonly invoke: (input: Json) => Promise<Json>;
};

export type AgentToolSet = ReadonlyArray<AgentTool>;

export const defineAgentTool = <S extends z.ZodType>(config: {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly invoke: (input: z.output<S>) => Promise<JsonSerializable>;
}): AgentTool => ({
  name: config.name,
  description: config.description,
  // SAFETY: zod v4's toJSONSchema returns a JSON Schema document, which is a
  // JSON object by construction.
  parameters: coerceJson(z.toJSONSchema(config.schema)) as JsonObject,
  schema: config.schema,
  invoke: async (input) => coerceJson(await config.invoke(config.schema.parse(input))),
});
