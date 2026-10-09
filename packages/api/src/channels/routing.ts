import type { ChannelBinding } from 'agentdock-sdk/schemas';

/** What the platform tells us about an inbound message. */
export type ConversationFacts = {
  readonly isDM: boolean;
  readonly workspaceId: string | undefined;
  readonly channelId: string;
  readonly userId: string;
  readonly isMention: boolean;
  readonly isSubscribed: boolean;
};

export type RoutingDecision =
  | { readonly kind: 'dispatch'; readonly binding: ChannelBinding }
  | { readonly kind: 'ignore'; readonly reason: 'no-binding' | 'user-not-allowed' | 'mention-required' };

const matches = (binding: ChannelBinding, facts: ConversationFacts): boolean => {
  const { match } = binding;
  if (match.workspaceId !== undefined && match.workspaceId !== facts.workspaceId) return false;
  switch (match.peerKind) {
    case 'direct':
      return facts.isDM && (match.peerId === undefined || match.peerId === facts.userId);
    case 'channel':
      return !facts.isDM && (match.peerId === undefined || match.peerId === facts.channelId);
    case undefined:
      return true;
  }
};

const specificity = (binding: ChannelBinding): number =>
  (binding.match.peerId !== undefined ? 8 : 0) +
  (binding.match.workspaceId !== undefined ? 4 : 0) +
  (binding.match.peerKind !== undefined ? 2 : 0);

/**
 * Pick the most specific enabled binding for a conversation, then apply its
 * admission rules. Ties keep creation order, so `bindings` must be sorted by
 * `createdAt`. Bindings choose the target; they never widen access beyond
 * their own allowlist.
 */
export const resolveBinding = (bindings: ReadonlyArray<ChannelBinding>, facts: ConversationFacts): RoutingDecision => {
  let best: ChannelBinding | undefined;
  for (const binding of bindings) {
    if (!binding.enabled || !matches(binding, facts)) continue;
    if (best === undefined || specificity(binding) > specificity(best)) best = binding;
  }
  if (!best) return { kind: 'ignore', reason: 'no-binding' };
  if (best.allowedUserIds.length > 0 && !best.allowedUserIds.includes(facts.userId)) {
    return { kind: 'ignore', reason: 'user-not-allowed' };
  }
  if (!facts.isDM && best.requireMention && !facts.isMention && !facts.isSubscribed) {
    return { kind: 'ignore', reason: 'mention-required' };
  }
  return { kind: 'dispatch', binding: best };
};
