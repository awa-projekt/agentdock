/**
 * In-memory store of posts, keyed by a local id we own (independent of the
 * AgentDock task id). A real app would persist this; for the example it resets
 * on restart. AgentDock remains the source of truth for the *run* itself — we
 * only cache the slice the UI needs.
 *
 * `WorkflowEvent` mirrors AgentDock's run-event wire shape. For fully typed
 * schemas, import `WorkflowRunEvent` from `agentdock-sdk/schemas` instead.
 */

import { z } from 'zod';

export type PostStatus =
  | 'drafting'
  | 'awaiting-review'
  | 'awaiting-approval'
  | 'revising'
  | 'publishing'
  | 'published'
  | 'rejected'
  | 'failed'
  | 'canceled';

/**
 * AgentDock's run-event wire shape, as much of it as this app needs: a `type`
 * discriminator plus whatever fields that event carries, passed through to the
 * developer drawer. For fully typed events, import `WorkflowRunEvent` from
 * `agentdock-sdk/schemas` instead.
 */
export const WorkflowEvent = z.looseObject({ type: z.string() });
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

export type Post = {
  id: string;
  userId: string;
  brief: string;
  status: PostStatus;
  /** AgentDock task + context ids, learned from the A2A stream; used to resume. */
  taskId?: string;
  contextId?: string;
  /** The content currently under review / approved. */
  draft: string;
  title?: string;
  channel?: string;
  /** Set while the run is paused on the review step or on a tool approval. */
  pendingActionId?: string;
  /** The tool AgentDock holds for approval while the post is `awaiting-approval`. */
  pendingTool?: string;
  reviewTitle?: string;
  reviewDescription?: string;
  responseSchema?: string;
  publishedUrl?: string;
  finalOutput?: string;
  error?: string;
  userApproved?: boolean;
  events: WorkflowEvent[];
  createdAt: string;
  updatedAt: string;
  // Internal accumulators, not sent to the client.
  liveDraft: string;
  /** Streamed JSON fragments of the writer's structured answer. */
  liveArgs: string;
  lastAgentOutput?: string;
};

const posts = new Map<string, Post>();

export const createPost = (userId: string, brief: string): Post => {
  const now = new Date().toISOString();
  const post: Post = {
    id: crypto.randomUUID(),
    userId,
    brief,
    status: 'drafting',
    draft: '',
    events: [],
    createdAt: now,
    updatedAt: now,
    liveDraft: '',
    liveArgs: '',
  };
  posts.set(post.id, post);
  return post;
};

export const getPost = (id: string): Post | undefined => posts.get(id);

export const listPosts = (userId: string): Post[] =>
  [...posts.values()].filter((p) => p.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const touch = (post: Post): void => {
  post.updatedAt = new Date().toISOString();
};

/** Client-facing view: drop internal accumulators. */
export type PublicPost = Omit<Post, 'liveDraft' | 'liveArgs' | 'lastAgentOutput'>;

export const toPublic = (post: Post): PublicPost => {
  const { liveDraft: _l, liveArgs: _j, lastAgentOutput: _a, ...rest } = post;
  return rest;
};
