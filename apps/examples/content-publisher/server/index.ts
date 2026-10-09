/**
 * The example's "light backend": Hono + @hono/node-server.
 *
 * Responsibilities, and nothing more:
 *  - authenticate the user (demo cookie sessions) so the browser proves who it is;
 *  - own the only line to AgentDock's A2A endpoint, so the workflow host never
 *    needs to be reachable (or CORS-open) to the browser;
 *  - relay the run's event stream back to the browser as SSE.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { type ReviewResponse, sendReview, sendToolDecision, startDraft } from './a2a';
import { endSession, readUser, requireAuth, startSession, type User, verifyCredentials } from './auth';
import { CHANNELS, config } from './config';
import { type A2AEvent, relayRun, type ServerEvent } from './relay';
import { agentdockBaseUrl, getSettings, updateSettings } from './settings';
import { createPost, getPost, listPosts, type Post, type PostStatus, toPublic } from './store';

const app = new Hono<{ Variables: { user: User } }>();

/** Request bodies this API accepts. A body that does not match falls back to an empty one. */
const LoginBody = z.looseObject({ email: z.string().optional(), password: z.string().optional() }).catch({});
const SettingsBody = z
  .looseObject({ agentdockUrl: z.string().optional(), workflowId: z.string().optional() })
  .catch({});
const NewPostBody = z.looseObject({ brief: z.string().optional() }).catch({});
const ReviewBody = z
  .looseObject({
    approved: z.boolean().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    channel: z.string().optional(),
    feedback: z.string().optional(),
  })
  .catch({});
const ToolApprovalBody = z.looseObject({ accept: z.boolean().optional() }).catch({});

/** The slice of AgentDock's `GET /workflows` response the settings picker shows. */
const WorkflowListResponse = z
  .array(
    z.looseObject({
      id: z.string(),
      manifest: z.looseObject({ name: z.string(), description: z.string().optional() }),
    }),
  )
  .catch([]);

/** Reads the JSON request body through a schema, so a missing or malformed body is just an empty one. */
const readBody = async <Schema extends z.ZodType>(c: Context, schema: Schema): Promise<z.output<Schema>> =>
  schema.parse(await c.req.json().catch(() => undefined));

// --- auth -----------------------------------------------------------------

app.post('/api/login', async (c) => {
  const { email, password } = await readBody(c, LoginBody);
  const user = verifyCredentials(email ?? '', password ?? '');
  if (!user) return c.json({ error: 'Invalid email or password' }, 401);
  await startSession(c, user);
  return c.json({ user });
});

app.post('/api/logout', async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const user = await readUser(c);
  return c.json({ user: user ?? null, workflowConfigured: Boolean(getSettings().workflowId) });
});

app.get('/api/channels', (c) => c.json({ channels: CHANNELS }));

// --- dev settings ---------------------------------------------------------

app.get('/api/settings', requireAuth, (c) => c.json(getSettings()));

app.put('/api/settings', requireAuth, async (c) => {
  const body = await readBody(c, SettingsBody);
  return c.json(updateSettings({ agentdockUrl: body.agentdockUrl, workflowId: body.workflowId }));
});

/** Proxy AgentDock's workflow list so the settings panel can offer a picker. */
app.get('/api/agentdock/workflows', requireAuth, async (c) => {
  const base = (c.req.query('url') ?? agentdockBaseUrl()).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/workflows`, { signal: AbortSignal.timeout(5000) });
    // Listing workflows is an admin call; only the workflow's A2A endpoint is public.
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: 'AgentDock requires sign-in to list workflows' }, 502);
    }
    if (!res.ok) return c.json({ error: `AgentDock responded ${res.status}` }, 502);
    const list = WorkflowListResponse.parse(await res.json());
    return c.json({
      workflows: list.map((w) => ({ id: w.id, name: w.manifest.name, description: w.manifest.description ?? '' })),
    });
  } catch {
    return c.json({ error: `Could not reach AgentDock at ${base}` }, 502);
  }
});

// --- posts ----------------------------------------------------------------

/** Relays one leg of a run to the browser as SSE; a failure lands on the post instead of the connection. */
const streamRun = (c: Context, post: Post, events: AsyncIterable<A2AEvent>) =>
  streamSSE(c, async (stream) => {
    const emit = (event: ServerEvent) => stream.writeSSE({ data: JSON.stringify(event) });
    await emit({ type: 'post', post: toPublic(post) });
    try {
      await relayRun(events, post, emit);
    } catch (error) {
      post.status = 'failed';
      post.error = error instanceof Error ? error.message : String(error);
      await emit({ type: 'post', post: toPublic(post) });
      await emit({ type: 'error', message: post.error });
    }
    await emit({ type: 'done' });
  });

/**
 * Claims the signed-in user's post paused in `status`: clears its pending
 * action so it is answered once, and returns what the resume message needs.
 */
const claimPausedPost = (c: Context<{ Variables: { user: User } }>, status: PostStatus) => {
  const post = getPost(c.req.param('id') ?? '');
  if (!post || post.userId !== c.get('user').id) return { error: c.json({ error: 'Not found' }, 404) } as const;
  const { pendingActionId: actionId, taskId, contextId } = post;
  if (post.status !== status || !actionId || !taskId || !contextId) {
    return { error: c.json({ error: `This post is not ${status}` }, 409) } as const;
  }
  delete post.pendingActionId;
  return { post, paused: { actionId, taskId, contextId } } as const;
};

app.get('/api/posts', requireAuth, (c) => c.json({ posts: listPosts(c.get('user').id).map(toPublic) }));

app.get('/api/posts/:id', requireAuth, (c) => {
  const post = getPost(c.req.param('id'));
  if (!post || post.userId !== c.get('user').id) return c.json({ error: 'Not found' }, 404);
  return c.json({ post: toPublic(post) });
});

/** Start a new draft: opens an A2A task and streams the run back as SSE. */
app.post('/api/posts', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await readBody(c, NewPostBody);
  const brief = body.brief?.trim() ?? '';
  if (!brief) return c.json({ error: 'A brief is required' }, 400);

  const post = createPost(user.id, brief);
  return streamRun(c, post, startDraft(brief));
});

/** Submit the editorial decision, resuming the paused workflow. */
app.post('/api/posts/:id/respond', requireAuth, async (c) => {
  const found = claimPausedPost(c, 'awaiting-review');
  if ('error' in found) return found.error;
  const { post, paused } = found;

  const body = await readBody(c, ReviewBody);
  const approved = body.approved !== false;
  const response: ReviewResponse = { approved };
  if (body.title !== undefined) response.title = body.title;
  if (body.body !== undefined) response.body = body.body;
  if (body.channel !== undefined) response.channel = body.channel;
  if (body.feedback) response.feedback = body.feedback;

  // Reflect the human's edits in our cache before resuming.
  post.userApproved = approved;
  if (body.title !== undefined) post.title = body.title;
  if (body.channel !== undefined) post.channel = body.channel;
  if (body.body !== undefined) post.draft = body.body;
  post.status = approved ? 'publishing' : 'revising';

  return streamRun(c, post, sendReview({ ...paused, response }));
});

/**
 * Decide the `publish_post` call AgentDock holds for approval. This gate is
 * AgentDock's tool policy, separate from the editorial review: accepting runs
 * the held call and the resumed workflow collects its receipt, declining fails
 * the publish step.
 */
app.post('/api/posts/:id/tool-approval', requireAuth, async (c) => {
  const found = claimPausedPost(c, 'awaiting-approval');
  if ('error' in found) return found.error;
  const { post, paused } = found;

  const accept = (await readBody(c, ToolApprovalBody)).accept === true;
  if (accept) post.status = 'publishing';

  return streamRun(c, post, sendToolDecision({ ...paused, accept }));
});

// --- static (production) --------------------------------------------------

if (config.isProduction) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('/*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const { agentdockUrl, workflowId } = getSettings();
  console.log(`[content-publisher] backend listening on http://localhost:${info.port}`);
  console.log(`[content-publisher] AgentDock: ${agentdockUrl}`);
  console.log(
    workflowId
      ? `[content-publisher] workflow: ${workflowId}`
      : '[content-publisher] no workflow set yet — configure it in the in-app Settings panel (or via WORKFLOW_ID).',
  );
});
