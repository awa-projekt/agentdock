import * as NodeCrypto from 'node:crypto';
import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { tracedA2aClientFactory } from 'agentdock-sdk/a2a/client';
import { buildAgentA2aUrl } from 'agentdock-sdk/routes';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { Api } from '../api';
import { cliError, messageOf } from '../errors';

const agentId = Argument.String('agent-id').pipe(Argument.withDescription('Agent ID'));
const message = Argument.String('message').pipe(Argument.withDescription('Message to send'));

const asDirectoryUrl = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

type StreamEvent = Message | Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent;

const eventText = (event: StreamEvent): string =>
  event.kind === 'artifact-update'
    ? event.artifact.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('')
    : '';

const send = (agentId: string, message: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const clientFactory = yield* tracedA2aClientFactory;
    yield* Effect.tryPromise({
      try: async () => {
        const client = await clientFactory.createFromUrl(asDirectoryUrl(buildAgentA2aUrl(api.baseUrl, agentId)));
        const stream = client.sendMessageStream({
          message: {
            kind: 'message',
            messageId: NodeCrypto.randomUUID(),
            role: 'user',
            parts: [{ kind: 'text', text: message }],
          },
        });
        for await (const event of stream) {
          const text = eventText(event);
          if (text.length > 0) process.stdout.write(text);
        }
        process.stdout.write('\n');
      },
      catch: (error) => cliError(`Sending to agent ${agentId} failed: ${messageOf(error)}`),
    });
  });

export const sendCommand = Command.make('send', { agentId, message }, ({ agentId, message }) =>
  send(agentId, message),
).pipe(Command.withDescription('Send a message to an agent over a2a and stream the reply'));
