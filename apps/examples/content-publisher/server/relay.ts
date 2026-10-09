/**
 * Translate AgentDock's A2A event stream into (a) updates to our cached `Post`
 * and (b) a simpler SSE feed for the browser.
 *
 * AgentDock surfaces everything as A2A events. The interesting signal rides
 * inside `status-update` messages as data parts:
 *   - `{ type: 'workflow-event', event }` — one per run/step event (what the
 *     developer drawer renders). The writer streams its draft as `step-progress`
 *     events with `state: 'a2a-artifact'`: the agent answers through its output
 *     contract, so the tokens are JSON fragments of `{ title, body, channel }`
 *     in `data.args` (an agent without a contract would stream `data.text`).
 *     The finished draft arrives as the `draft` step's output.
 *   - on `state: 'input-required'`, `{ type: 'workflow-human-input-request',
 *     actionId, title, responseSchema, ... }` — a pause. Usually that is the
 *     editorial gate; when AgentDock holds the `publish_post` call for approval
 *     instead, the raw interrupt in `interrupts` is a
 *     `workflow-tool-approval-request` naming the tool.
 */
import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { z } from 'zod';
import { type Post, type PublicPost, toPublic, touch, WorkflowEvent } from './store';

export type A2AEvent = Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export type ServerEvent =
  | { type: 'post'; post: PublicPost }
  | { type: 'delta'; text: string }
  | { type: 'event'; event: WorkflowEvent }
  | { type: 'error'; message: string }
  | { type: 'done' };

type Emit = (event: ServerEvent) => Promise<void> | void;

/** Accepts either a payload object or the JSON text of one. */
const jsonTextOrValue = z.union([
  z.string().transform((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }),
  z.unknown(),
]);

const ArticleFields = z.looseObject({
  title: z.string().optional(),
  body: z.string().optional(),
  channel: z.string().optional(),
});
type ArticleFields = z.infer<typeof ArticleFields>;

/** An article as it arrives from the workflow: the object itself, or JSON text holding it. */
const ArticleLike = jsonTextOrValue.pipe(ArticleFields);

/** The `draft` step's output: JSON text holding `{ article }`. */
const StepOutput = jsonTextOrValue.pipe(z.looseObject({ article: z.unknown() }));

/** The run's final output: JSON text holding the workflow's declared output contract. */
const RunOutput = jsonTextOrValue.pipe(z.looseObject({ url: z.string().optional(), status: z.string().optional() }));

/** The human-input request fields the review UI needs. */
const ReviewRequest = z.looseObject({
  actionId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  responseSchema: z.string().optional(),
  input: z.unknown().optional(),
  interrupts: z.unknown().optional(),
});
type ReviewRequest = z.infer<typeof ReviewRequest>;

/** The raw interrupts behind a pause, and the one shape that marks a tool approval. */
const Interrupts = z.array(z.looseObject({ value: z.unknown() })).catch([]);
const ToolApprovalRequest = z.looseObject({
  type: z.literal('workflow-tool-approval-request'),
  tool: z.looseObject({ path: z.string() }),
});

/** The tool AgentDock holds for approval, when this pause is one. */
const heldTool = (request: ReviewRequest): string | undefined => {
  for (const { value } of Interrupts.parse(request.interrupts)) {
    const approval = ToolApprovalRequest.safeParse(value);
    if (approval.success) return approval.data.tool.path;
  }
  return undefined;
};

/**
 * The run events this app reacts to. Every other event still reaches the
 * developer drawer untouched — only these carry fields we read.
 */
const KnownWorkflowEvent = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('run-started') }),
  z.looseObject({
    type: z.literal('step-progress'),
    state: z.string().optional(),
    data: z.looseObject({ text: z.string().optional(), args: z.string().optional() }).optional(),
  }),
  z.looseObject({ type: z.literal('step-completed'), output: z.string().optional() }),
  ReviewRequest.extend({ type: z.literal('human-input-requested') }),
  z.looseObject({ type: z.literal('human-input-resolved') }),
  z.looseObject({ type: z.literal('run-completed'), output: z.string().optional() }),
  z.looseObject({ type: z.literal('run-failed'), error: z.string().optional() }),
  z.looseObject({ type: z.literal('run-canceled') }),
]);

/** A `status-update` data part: a workflow event envelope, or the raw human-input request. */
const StatusData = z.looseObject({
  type: z.string().optional(),
  event: z.unknown(),
});

const dataOf = (message: Message | undefined): z.infer<typeof StatusData> | undefined => {
  for (const part of message?.parts ?? []) {
    if (part.kind !== 'data') continue;
    const parsed = StatusData.safeParse(part.data);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

const textOf = (message: Message | undefined): string =>
  message?.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('') ?? '';

/** The post fields the relay fills in from a run, and clears when a run no longer reports them. */
type OptionalPostKey =
  | 'pendingActionId'
  | 'pendingTool'
  | 'reviewTitle'
  | 'reviewDescription'
  | 'responseSchema'
  | 'publishedUrl';

const setOptional = (target: Post, key: OptionalPostKey, value: string | undefined): void => {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
};

const extractUrl = (text: string): string | undefined => text.match(/https?:\/\/[^\s)"']+/)?.[0];

/**
 * The `body` field of a JSON object that is still being streamed: everything
 * after `"body":"` up to the closing quote (or the end of what has arrived),
 * with JSON escapes undone. Enough to show the draft growing while the agent
 * writes it; the complete article arrives with the `draft` step's output.
 */
const partialBody = (json: string): string => {
  const start = json.indexOf('"body":"');
  if (start === -1) return '';
  let out = '';
  for (let i = start + '"body":"'.length; i < json.length; i += 1) {
    const char = json[i];
    if (char === '"') break;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = json[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(json.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += next;
  }
  return out;
};

const applyArticle = (post: Post, article: ArticleFields | undefined): void => {
  if (article?.title) post.title = article.title;
  if (article?.body) post.draft = article.body;
  if (article?.channel) post.channel = article.channel;
};

const startReview = (post: Post, request: ReviewRequest): void => {
  setOptional(post, 'pendingActionId', request.actionId);
  setOptional(post, 'reviewTitle', request.title);
  setOptional(post, 'reviewDescription', request.description);
  setOptional(post, 'responseSchema', request.responseSchema);
  post.status = 'awaiting-review';
  const requested = ArticleLike.safeParse(request.input);
  if (requested.success) applyArticle(post, requested.data);
  if (post.draft) {
    touch(post);
    return;
  }
  // The event carried no article: fall back to the last draft the agent produced.
  const lastOutput = ArticleLike.safeParse(post.lastAgentOutput);
  if (lastOutput.success) applyArticle(post, lastOutput.data);
  if (!post.draft) post.draft = post.lastAgentOutput ?? post.liveDraft;
  touch(post);
};

const startToolApproval = (post: Post, request: ReviewRequest, tool: string): void => {
  setOptional(post, 'pendingActionId', request.actionId);
  setOptional(post, 'pendingTool', tool);
  setOptional(post, 'reviewTitle', request.title);
  setOptional(post, 'reviewDescription', request.description);
  post.status = 'awaiting-approval';
  touch(post);
};

const pause = (post: Post, request: ReviewRequest): void => {
  const tool = heldTool(request);
  if (tool === undefined) startReview(post, request);
  else startToolApproval(post, request, tool);
};

export const relayRun = async (events: AsyncIterable<A2AEvent>, post: Post, emit: Emit): Promise<void> => {
  const emitPost = () => emit({ type: 'post', post: toPublic(post) });

  const onWorkflowEvent = async (wf: WorkflowEvent): Promise<void> => {
    post.events.push(wf);
    touch(post);
    await emit({ type: 'event', event: wf });

    const known = KnownWorkflowEvent.safeParse(wf);
    if (!known.success) return;
    const event = known.data;

    switch (event.type) {
      case 'run-started':
        post.status = 'drafting';
        await emitPost();
        break;
      case 'step-progress': {
        if (event.state !== 'a2a-artifact') break;
        const text = event.data?.text;
        const args = event.data?.args;
        if (text) {
          post.liveDraft += text;
          await emit({ type: 'delta', text });
        } else if (args) {
          post.liveArgs += args;
          const body = partialBody(post.liveArgs);
          if (body.length > post.liveDraft.length && body.startsWith(post.liveDraft)) {
            const delta = body.slice(post.liveDraft.length);
            post.liveDraft = body;
            await emit({ type: 'delta', text: delta });
          }
        }
        break;
      }
      case 'step-completed': {
        // The `draft` step's update carries the structured article; a revision
        // replaces the draft under review.
        const output = StepOutput.safeParse(event.output);
        if (!output.success) break;
        const article = ArticleLike.safeParse(output.data.article);
        if (article.success && article.data.body) {
          post.lastAgentOutput = JSON.stringify(output.data.article);
          post.liveDraft = '';
          post.liveArgs = '';
          applyArticle(post, article.data);
        }
        break;
      }
      case 'human-input-requested':
        pause(post, event);
        await emitPost();
        break;
      case 'human-input-resolved':
        // A tool approval keeps the status its decision set; the run's outcome follows.
        if (post.pendingTool === undefined) post.status = post.userApproved === false ? 'revising' : 'publishing';
        else setOptional(post, 'pendingTool', undefined);
        await emitPost();
        break;
      case 'run-completed': {
        post.finalOutput = event.output ?? '';
        const output = RunOutput.safeParse(post.finalOutput);
        const url = output.success ? output.data.url : undefined;
        setOptional(post, 'publishedUrl', url ?? extractUrl(post.finalOutput));
        post.status = output.success && output.data.status === 'published' ? 'published' : 'rejected';
        touch(post);
        await emitPost();
        break;
      }
      case 'run-failed':
        post.status = 'failed';
        post.error = event.error ?? 'Run failed';
        await emitPost();
        break;
      case 'run-canceled':
        post.status = 'canceled';
        await emitPost();
        break;
    }
  };

  for await (const event of events) {
    switch (event.kind) {
      case 'task':
        post.taskId = event.id;
        post.contextId = event.contextId;
        break;
      case 'artifact-update':
        post.taskId ??= event.taskId;
        post.contextId ??= event.contextId;
        break;
      case 'status-update': {
        post.taskId ??= event.taskId;
        post.contextId ??= event.contextId;
        const message = event.status.message;
        const data = dataOf(message);
        const workflowEvent = data?.type === 'workflow-event' ? WorkflowEvent.safeParse(data.event) : undefined;
        if (workflowEvent?.success) {
          await onWorkflowEvent(workflowEvent.data);
        } else if (
          event.status.state === 'input-required' &&
          data &&
          post.status !== 'awaiting-review' &&
          post.status !== 'awaiting-approval'
        ) {
          // Fallback if the workflow-event form wasn't seen first.
          const request = ReviewRequest.safeParse(data);
          if (request.success) {
            pause(post, request.data);
            await emitPost();
          }
        } else if (event.status.state === 'failed' || event.status.state === 'rejected') {
          post.status = 'failed';
          post.error = textOf(message) || 'Run failed';
          touch(post);
          await emitPost();
        }
        break;
      }
      case 'message':
        break;
    }
  }
};
