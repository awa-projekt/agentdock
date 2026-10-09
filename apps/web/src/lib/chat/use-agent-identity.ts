import { useCallback } from 'react';
import { subagentLabel } from '@/lib/chat/events';
import type { TimelineItem } from '@/lib/chat/model';
import { useAgents } from '@/lib/queries';

export type AgentIdentity = { readonly name: string; readonly color: string | undefined };

/** Resolve a delegation to the registered agent's name and colour, falling back to what the relay carried. */
export const useAgentIdentity = (): ((item: Extract<TimelineItem, { kind: 'subagent' }>) => AgentIdentity) => {
  const agents = useAgents().data;
  return useCallback(
    (item) => {
      const agent = item.agentId === undefined ? undefined : agents?.find((entry) => entry.id === item.agentId);
      return { name: agent?.name ?? subagentLabel(item), color: agent?.color };
    },
    [agents],
  );
};
