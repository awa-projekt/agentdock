import { describe, expect, it } from '@effect/vitest';
import * as Schema from 'effect/Schema';
import { GraphMessagesResponse } from './graph';

const decode = Schema.decodeUnknownSync(GraphMessagesResponse);

describe('GraphMessagesResponse', () => {
  it('keeps the fields a normalized email is built from and drops the rest', () => {
    const { value } = decode({
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/messages',
      value: [
        {
          id: 'AAMkAD',
          subject: 'Invoice 42',
          from: { emailAddress: { name: 'Ada', address: 'ada@example.com' } },
          receivedDateTime: '2026-09-16T08:00:00Z',
          bodyPreview: 'Please review',
          body: { contentType: 'text', content: 'Please review the attached invoice.' },
          isRead: false,
        },
      ],
    });

    expect(value).toEqual([
      {
        id: 'AAMkAD',
        subject: 'Invoice 42',
        from: { emailAddress: { address: 'ada@example.com' } },
        receivedDateTime: '2026-09-16T08:00:00Z',
        bodyPreview: 'Please review',
        body: { content: 'Please review the attached invoice.' },
      },
    ]);
  });

  it('accepts a message without the optional subject, sender and body fields', () => {
    const { value } = decode({ value: [{ id: 'AAMkAE', receivedDateTime: '2026-09-16T09:00:00Z' }] });

    expect(value).toEqual([{ id: 'AAMkAE', receivedDateTime: '2026-09-16T09:00:00Z' }]);
  });

  it('rejects a message missing the id the watermark is keyed on', () => {
    expect(() => decode({ value: [{ receivedDateTime: '2026-09-16T09:00:00Z' }] })).toThrow();
  });
});
