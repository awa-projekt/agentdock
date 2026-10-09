import { z } from 'zod';
import { isJsonObject, type Json } from '../../schemas/json';
import type { AgentToolSet } from '../types';
import { defineAgentTool } from '../types';

export type NativeIntegrationToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json | undefined;
  readonly invoke: (input: Json) => Promise<Json>;
};

const NO_INPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * Integration tools the model calls directly, one LLM tool per catalog tool.
 *
 * The input schema arrives as JSON Schema from the integration's own metadata,
 * so it is handed to the agent loop unconverted: a zod round-trip would flatten
 * nesting, enums and required-ness the source already got right.
 */
export const createNativeIntegrationTools = (
  definitions: ReadonlyArray<NativeIntegrationToolDefinition>,
): AgentToolSet =>
  definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: isJsonObject(definition.inputSchema) ? definition.inputSchema : NO_INPUT_SCHEMA,
    invoke: definition.invoke,
  }));

export const APPROVE_TOOL_CALL_NAME = 'approve_tool_call';

export type CodeModeOperations = {
  readonly description: string;
  readonly execute: (input: { readonly code: string }) => Promise<Json>;
};

/** The sandbox entry point: code-mode tools are reachable only from inside a script. */
export const createCodeModeTools = (operations: CodeModeOperations): AgentToolSet => [
  defineAgentTool({
    name: 'executeTs',
    description: operations.description,
    schema: z.object({
      code: z.string().min(1).describe('TypeScript code to run against the tools reachable from this agent.'),
    }),
    invoke: (input) => operations.execute(input),
  }),
];

export type ApprovalDecisionAction = 'accept' | 'decline';

/**
 * The continuation the agent loop calls with the human's answer once a tool
 * call froze for approval. It is listed with the other tools because the loop
 * resolves continuations by name from the same set the model sees. `collect`
 * asks for the tool's own result once approved; a script re-runs instead.
 */
export const createApprovalTool = (
  decide: (input: {
    readonly approvalId: string;
    readonly action: ApprovalDecisionAction;
    readonly collect: boolean;
  }) => Promise<Json>,
): AgentToolSet => [
  defineAgentTool({
    name: APPROVE_TOOL_CALL_NAME,
    description:
      'Records the human decision on a frozen tool call. Only call this with a decision the user gave explicitly.',
    schema: z.object({
      approvalId: z.string().describe('The approvalId from the approval request.'),
      action: z.enum(['accept', 'decline', 'cancel']).describe('The decision the user gave.'),
      collect: z.boolean().optional(),
      content: z.unknown().optional(),
    }),
    invoke: ({ approvalId, action, collect }) =>
      decide({ approvalId, action: action === 'accept' ? 'accept' : 'decline', collect: collect ?? false }),
  }),
];
