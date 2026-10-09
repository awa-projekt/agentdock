import type { ChannelBinding } from 'agentdock-sdk/schemas';
import { ChannelBinding as ChannelBindingSchema } from 'agentdock-sdk/schemas';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { type ConversationFacts, resolveBinding } from './routing';

const decode = Schema.decodeUnknownSync(ChannelBindingSchema);

let counter = 0;
const binding = (overrides: Partial<Omit<ChannelBinding, 'id' | 'createdAt' | 'updatedAt'>>): ChannelBinding =>
  decode({
    id: `chb_${counter}`,
    accountId: 'cha_1',
    name: `binding ${counter}`,
    enabled: true,
    target: { kind: 'agent', id: `agent-${counter++}` },
    match: {},
    requireMention: true,
    allowedUserIds: [],
    createdAt: counter,
    updatedAt: counter,
    ...overrides,
  });

const facts = (overrides: Partial<ConversationFacts> = {}): ConversationFacts => ({
  isDM: false,
  workspaceId: 'g1',
  channelId: 'c1',
  userId: 'u1',
  isMention: true,
  isSubscribed: false,
  ...overrides,
});

describe('resolveBinding', () => {
  it('prefers a channel-specific binding over the account fallback', () => {
    const fallback = binding({ match: {} });
    const channel = binding({ match: { peerKind: 'channel', peerId: 'c1' } });
    const decision = resolveBinding([fallback, channel], facts());
    expect(decision).toEqual({ kind: 'dispatch', binding: channel });
  });

  it('routes DMs only to bindings that accept direct conversations', () => {
    const channelOnly = binding({ match: { peerKind: 'channel' } });
    expect(resolveBinding([channelOnly], facts({ isDM: true, workspaceId: undefined }))).toEqual({
      kind: 'ignore',
      reason: 'no-binding',
    });
    const dm = binding({ match: { peerKind: 'direct', peerId: 'u1' } });
    expect(resolveBinding([channelOnly, dm], facts({ isDM: true, workspaceId: undefined })).kind).toBe('dispatch');
  });

  it('requires a mention in group channels unless the binding opts out, never in DMs', () => {
    const strict = binding({ match: {}, requireMention: true });
    expect(resolveBinding([strict], facts({ isMention: false }))).toEqual({
      kind: 'ignore',
      reason: 'mention-required',
    });
    expect(resolveBinding([strict], facts({ isDM: true, isMention: false })).kind).toBe('dispatch');
    expect(resolveBinding([strict], facts({ isMention: false, isSubscribed: true })).kind).toBe('dispatch');
    const relaxed = binding({ match: {}, requireMention: false });
    expect(resolveBinding([relaxed], facts({ isMention: false })).kind).toBe('dispatch');
  });

  it('applies the winning binding allowlist instead of falling through to a broader binding', () => {
    const open = binding({ match: {} });
    const restricted = binding({ match: { workspaceId: 'g1' }, allowedUserIds: ['u2'] });
    expect(resolveBinding([open, restricted], facts())).toEqual({ kind: 'ignore', reason: 'user-not-allowed' });
  });

  it('skips disabled bindings and bindings for other workspaces', () => {
    const disabled = binding({ match: { peerKind: 'channel', peerId: 'c1' }, enabled: false });
    const otherWorkspace = binding({ match: { workspaceId: 'g2' } });
    expect(resolveBinding([disabled, otherWorkspace], facts())).toEqual({ kind: 'ignore', reason: 'no-binding' });
  });
});
