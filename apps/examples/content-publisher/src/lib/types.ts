/**
 * Wire types shared with the backend (see server/store.ts, server/relay.ts).
 * The ones that arrive over the SSE stream are schemas, so a frame is parsed
 * once on arrival instead of being trusted field by field.
 */
import { z } from 'zod';

export const PostStatus = z.enum([
  'drafting',
  'awaiting-review',
  'awaiting-approval',
  'revising',
  'publishing',
  'published',
  'rejected',
  'failed',
  'canceled',
]);
export type PostStatus = z.infer<typeof PostStatus>;

/**
 * AgentDock's run-event wire shape: a `type` discriminator plus whatever that
 * event carries, rendered as-is by the developer drawer.
 */
export const WorkflowEvent = z.looseObject({ type: z.string() });
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

export const Post = z.object({
  id: z.string(),
  userId: z.string(),
  brief: z.string(),
  status: PostStatus,
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  draft: z.string(),
  title: z.string().optional(),
  channel: z.string().optional(),
  pendingActionId: z.string().optional(),
  pendingTool: z.string().optional(),
  reviewTitle: z.string().optional(),
  reviewDescription: z.string().optional(),
  responseSchema: z.string().optional(),
  publishedUrl: z.string().optional(),
  finalOutput: z.string().optional(),
  error: z.string().optional(),
  userApproved: z.boolean().optional(),
  events: z.array(WorkflowEvent),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Post = z.infer<typeof Post>;

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post'), post: Post }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('event'), event: WorkflowEvent }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('done') }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export type User = { id: string; email: string; name: string };

export type Settings = { agentdockUrl: string; workflowId: string };

export type AgentdockWorkflow = { id: string; name: string; description: string };

export type ReviewDecision = {
  approved: boolean;
  title?: string;
  body?: string;
  channel?: string;
  feedback?: string;
};
