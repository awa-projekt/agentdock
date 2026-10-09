import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { AgentSkills } from '../schemas/agents';
import { type JsonObject, JsonObject as JsonObjectSchema } from '../schemas/json';
import type { ReasoningEffort } from '../schemas/reasoning';

/**
 * The minimal runtime input the agent loop needs. Structurally satisfied by
 * the platform `AgentRecord` schema type, but intentionally decoupled from it so
 * `runAgent` and the loop abstraction work for hand-built agents too (evals,
 * sweeps, bundles).
 */
export type AgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  /** Provider-neutral thinking budget; `null`/absent leaves the provider default. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /** Injected skills are already folded into `instructions`; on-demand ones are loadable with `load_skill`. */
  readonly skills?: AgentSkills | undefined;
  /** Parsed JSON Schema; when set the loop runs with structured output. */
  readonly outputSchema?: JsonObject | undefined;
};

const decodeSchemaText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema));

/** Parses a serialized output-contract JSON Schema; a malformed schema disables the contract. */
export const agentOutputSchema = (agent: {
  readonly outputContract?: { readonly schema: string } | null | undefined;
}): JsonObject | undefined => {
  const schema = agent.outputContract?.schema;
  return schema ? Option.getOrUndefined(decodeSchemaText(schema)) : undefined;
};
