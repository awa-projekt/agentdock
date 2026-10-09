/**
 * Thin wrapper over AgentDock's A2A endpoint for the publisher workflow.
 *
 * Three interactions, all returning the live event stream:
 *  - `startDraft(brief)` opens a new task with a data part `{ brief }`, the
 *    workflow's input contract.
 *  - `sendReview(...)` continues the *same* task with the editor's decision,
 *    which resumes the workflow from its paused `review` step.
 *  - `sendToolDecision(...)` continues it with an approval decision when
 *    AgentDock holds the `publish_post` call for approval.
 *
 * A resume message must carry the original `taskId`/`contextId` and a data
 * part of `{ type: 'workflow-human-input-response', actionId, response }` —
 * that's the contract AgentDock's workflow executor matches on.
 */

import type { Message, MessageSendParams } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { ClientFactory } from '@a2a-js/sdk/client';
import { getSettings, workflowA2aUrl } from './settings';

// Cache the client by its resolved URL so changing the workflow/AgentDock URL
// from the settings panel transparently rebuilds it on the next call.
let cached: { url: string; client: Promise<Client> } | undefined;

const getClient = (): Promise<Client> => {
  if (!getSettings().workflowId) {
    throw new Error('No workflow is configured. Pick one in the in-app Settings panel (or set WORKFLOW_ID).');
  }
  const url = `${workflowA2aUrl()}/`;
  if (!cached || cached.url !== url) {
    cached = { url, client: new ClientFactory().createFromUrl(url) };
  }
  return cached.client;
};

async function* send(message: Message) {
  const client = await getClient();
  const params: MessageSendParams = { configuration: { blocking: false }, message };
  yield* client.sendMessageStream(params);
}

export const startDraft = (brief: string) =>
  send({
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'data', data: { brief } }],
  });

/** The editorial decision sent back to the paused human-input node. */
export type ReviewResponse = {
  approved: boolean;
  title?: string;
  body?: string;
  channel?: string;
  feedback?: string;
};

/** Where a resume message goes: the paused task and the action it answers. */
type PausedAction = {
  readonly taskId: string;
  readonly contextId: string;
  readonly actionId: string;
};

/** AgentDock decides the held tool call with `accept`; anything else runs it, so declining must say `decline`. */
type ToolDecision = { action: 'accept' | 'decline' };

const answer = (args: PausedAction, response: ReviewResponse | ToolDecision) =>
  send({
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    taskId: args.taskId,
    contextId: args.contextId,
    parts: [
      {
        kind: 'data',
        data: {
          type: 'workflow-human-input-response',
          actionId: args.actionId,
          response,
        },
      },
    ],
  });

export const sendReview = (args: PausedAction & { readonly response: ReviewResponse }) => answer(args, args.response);

export const sendToolDecision = (args: PausedAction & { readonly accept: boolean }) =>
  answer(args, { action: args.accept ? 'accept' : 'decline' });
