import { z } from 'zod';
import type { AgentdockWorkflow, Post, ReviewDecision, Settings, User } from './types';
import { ServerEvent } from './types';

/** How this API reports a failure. */
const ErrorBody = z.looseObject({ error: z.string().optional() }).catch({});

const failure = async (res: Response): Promise<Error> =>
  new Error(ErrorBody.parse(await res.json().catch(() => undefined)).error ?? res.statusText);

const json = async (res: Response) => {
  if (!res.ok) throw await failure(res);
  return res.json();
};

export const api = {
  me: (): Promise<{ user: User | null; workflowConfigured: boolean }> => fetch('/api/me').then(json),

  login: (email: string, password: string): Promise<{ user: User }> =>
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(json),

  logout: (): Promise<{ ok: boolean }> => fetch('/api/logout', { method: 'POST' }).then(json),

  channels: (): Promise<{ channels: string[] }> => fetch('/api/channels').then(json),

  getSettings: (): Promise<Settings> => fetch('/api/settings').then(json),

  updateSettings: (next: Partial<Settings>): Promise<Settings> =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).then(json),

  agentdockWorkflows: (url?: string): Promise<{ workflows: AgentdockWorkflow[] }> =>
    fetch(`/api/agentdock/workflows${url ? `?url=${encodeURIComponent(url)}` : ''}`).then(json),

  listPosts: (): Promise<{ posts: Post[] }> => fetch('/api/posts').then(json),

  getPost: (id: string): Promise<{ post: Post }> => fetch(`/api/posts/${id}`).then(json),
};

/** Read a `data: <json>\n\n` SSE body, invoking `onEvent` per parsed message. */
const consumeSSE = async (res: Response, onEvent: (event: ServerEvent) => void): Promise<void> => {
  if (!res.ok || !res.body) throw await failure(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload) onEvent(ServerEvent.parse(JSON.parse(payload)));
    }
  }
};

/** Start a new draft; streams the run until `done`. */
export const startDraft = (brief: string, onEvent: (e: ServerEvent) => void): Promise<void> =>
  fetch('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief }),
  }).then((res) => consumeSSE(res, onEvent));

/** Decide the tool call AgentDock holds for approval; streams the resumed run until `done`. */
export const decideToolCall = (id: string, accept: boolean, onEvent: (e: ServerEvent) => void): Promise<void> =>
  fetch(`/api/posts/${id}/tool-approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept }),
  }).then((res) => consumeSSE(res, onEvent));

/** Submit an editorial decision; streams the resumed run until `done`. */
export const respond = (id: string, decision: ReviewDecision, onEvent: (e: ServerEvent) => void): Promise<void> =>
  fetch(`/api/posts/${id}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  }).then((res) => consumeSSE(res, onEvent));
