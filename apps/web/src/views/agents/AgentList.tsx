import type { AgentRecord } from 'agentdock-sdk/schemas';
import { SelectableCard } from '@/components/SelectableCard';
import { AgentIcon } from '@/views/agents/AgentIcon';

export function AgentList({
  agents,
  selectedId,
  onSelect,
}: {
  agents: ReadonlyArray<AgentRecord>;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {agents.map((agent) => (
        <li key={agent.id}>
          <SelectableCard
            onClick={() => onSelect(agent.id)}
            active={agent.id === selectedId}
            className="flex min-w-0 items-center gap-3"
          >
            <AgentIcon color={agent.color} className="size-8 rounded-md" iconClassName="size-4" />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-sm font-medium">{agent.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{agent.model}</span>
            </span>
          </SelectableCard>
        </li>
      ))}
    </ul>
  );
}
