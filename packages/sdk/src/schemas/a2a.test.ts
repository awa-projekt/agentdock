import type { MessageSendParams } from '@a2a-js/sdk';
import { describe, expect, it } from '@effect/vitest';
import * as Schema from 'effect/Schema';
import { A2AMessageSendParams, A2ASetPushNotificationConfigBody } from './a2a';

const decodeSendParams = Schema.decodeUnknownResult(A2AMessageSendParams);
const decodePushConfigBody = Schema.decodeUnknownResult(A2ASetPushNotificationConfigBody);

describe('A2AMessageSendParams', () => {
  it('decodes a REST message/send body into the a2a params the request handler takes', () => {
    const decoded = decodeSendParams({
      message: {
        kind: 'message',
        messageId: 'message-1',
        role: 'user',
        parts: [
          { kind: 'text', text: 'Draft this.' },
          { kind: 'data', data: { brief: 'a brief' } },
          { kind: 'file', file: { uri: 'https://example.com/brief.md', mimeType: 'text/markdown' } },
        ],
      },
      configuration: { blocking: false, acceptedOutputModes: ['text/plain'] },
    });

    expect(decoded._tag).toBe('Success');
    if (decoded._tag !== 'Success') return;
    // The decoded value is the handler's own contract, with no assertion in between.
    const params: MessageSendParams = decoded.success;
    expect(params.message.parts).toHaveLength(3);
    expect(params.configuration?.blocking).toBe(false);
  });

  it('rejects a body whose message is not an a2a message', () => {
    expect(decodeSendParams({ message: { kind: 'task', id: 'task-1' } })._tag).toBe('Failure');
    expect(decodeSendParams({})._tag).toBe('Failure');
  });
});

describe('A2ASetPushNotificationConfigBody', () => {
  it('rejects a push notification config without a callback url', () => {
    expect(decodePushConfigBody({ pushNotificationConfig: { token: 'secret' } })._tag).toBe('Failure');
    expect(decodePushConfigBody({ pushNotificationConfig: { url: 'https://example.com/hook' } })._tag).toBe('Success');
  });
});
