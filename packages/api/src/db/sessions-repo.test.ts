import type { Message } from '@a2a-js/sdk';
import { describe, expect, it } from '@effect/vitest';
import { a2aContextMessagesTable } from 'db';
import * as Effect from 'effect/Effect';
import { makeTestDb } from '../workflows/test-db';
import { createSessionRepo } from './sessions-repo';

const message: Message = {
  kind: 'message',
  role: 'user',
  messageId: 'msg-1',
  contextId: 'ctx-1',
  parts: [{ kind: 'text', text: 'hello' }],
};

describe('createSessionRepo — context message column decoding', () => {
  it.effect('returns persisted messages and drops rows that no longer match the a2a message shape', () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(makeTestDb);
      const repo = createSessionRepo(db, (cause) => new Error(String(cause)));

      yield* Effect.promise(() =>
        db
          .insert(a2aContextMessagesTable)
          .values([
            {
              targetId: 'agent-1',
              branchId: 'br-1',
              contextId: 'ctx-1',
              messageId: 'msg-1',
              messageIndex: 0,
              message,
              createdAt: 1,
            },
            {
              targetId: 'agent-1',
              branchId: 'br-1',
              contextId: 'ctx-1',
              messageId: 'msg-2',
              messageIndex: 1,
              message: { kind: 'message', messageId: 'msg-2' },
              createdAt: 2,
            },
          ])
          .run(),
      );

      const rows = yield* Effect.promise(() => repo.messagesFor('agent-1', 'ctx-1'));
      expect(rows).toEqual([{ message, createdAt: 1 }]);

      const byContext = yield* Effect.promise(() => repo.hydrateContextMessages('agent-1'));
      expect(byContext.get('ctx-1')).toEqual([message]);
    }),
  );
});
