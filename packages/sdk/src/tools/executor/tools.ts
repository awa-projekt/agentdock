import { tool } from 'ai';
import { z } from 'zod';

export type ExecutorExecutionOperations = {
  readonly description: string;
  readonly execute: (input: { readonly code: string }) => Promise<unknown>;
  readonly resume: (input: {
    readonly executionId: string;
    readonly action: 'accept' | 'decline' | 'cancel';
    readonly content?: Record<string, unknown>;
  }) => Promise<unknown>;
};

export const createExecutorExecutionToolsFromOperations = (operations: ExecutorExecutionOperations) => ({
  execute: tool({
    description: operations.description,
    inputSchema: z.object({
      code: z.string().min(1).describe('TypeScript code to execute against this agent executor sources.'),
    }),
    execute: (input) => operations.execute(input),
  }),
  resume: tool({
    description: 'Resume a paused executor execution using the executionId returned by execute.',
    inputSchema: z.object({
      executionId: z.string().describe('The execution ID returned by execute.'),
      action: z.enum(['accept', 'decline', 'cancel']).describe('How to respond to the paused interaction.'),
      content: z.record(z.string(), z.unknown()).optional().describe('Optional form content for accepted interactions.'),
    }),
    execute: (input) =>
      operations.resume({
        executionId: input.executionId,
        action: input.action,
        ...(input.content ? { content: input.content } : {}),
      }),
  }),
});
