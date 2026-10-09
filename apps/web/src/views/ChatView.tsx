import { Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { ChatPanel } from '@/components/chat/chat-panel';
import { EmptyState } from '@/components/EmptyState';
import { ChatSkeleton } from '@/components/Loading';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { agentA2aUrl, chatPersistence, workflowA2aUrl } from '@/lib/api';
import { toErrorMessage } from '@/lib/format';
import { useAgents, useWorkflows } from '@/lib/queries';
import { chatPath, createAgentPath, decodeRouteParam, type routePatterns } from '@/lib/routing';
import { agentTargetId, type ChatTarget, workflowTargetId } from '@/lib/targets';

export function ChatView() {
  const [, navigate] = useLocation();
  const params = useParams<typeof routePatterns.chat>();
  const targetId = decodeRouteParam(params.agentId);
  const agentsQuery = useAgents();
  const workflowsQuery = useWorkflows();
  const agents = agentsQuery.data ?? [];
  const workflows = workflowsQuery.data ?? [];

  const chatTargets = useMemo<ReadonlyArray<ChatTarget>>(
    () => [
      ...agents.map((agent) => ({
        kind: 'agent' as const,
        id: agentTargetId(agent.id),
        name: agent.name,
        description: agent.description,
        url: agentA2aUrl(agent.id),
        agent,
      })),
      ...workflows.map((workflow) => ({
        kind: 'workflow' as const,
        id: workflowTargetId(workflow.id),
        name: workflow.manifest.name,
        description: workflow.manifest.description,
        url: workflowA2aUrl(workflow.id),
        workflow,
      })),
    ],
    [agents, workflows],
  );

  const chatTarget = chatTargets.find((target) => target.id === targetId) ?? chatTargets[0] ?? null;

  const persistence = useMemo(
    () => (chatTarget?.kind === 'agent' ? chatPersistence(chatTarget.agent.id) : undefined),
    [chatTarget],
  );

  const loadError = agentsQuery.error ?? workflowsQuery.error;
  if (loadError) return <ErrorBanner>{toErrorMessage(loadError, 'Could not load chat targets.')}</ErrorBanner>;

  const hasTargets = agents.length + workflows.length > 0;

  if (agentsQuery.isPending || workflowsQuery.isPending) {
    return <ChatSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {hasTargets ? (
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Select
            value={chatTarget?.id ?? ''}
            items={[
              ...agents.map((agent) => ({ value: agentTargetId(agent.id), label: agent.name })),
              ...workflows.map((workflow) => ({
                value: workflowTargetId(workflow.id),
                label: workflow.manifest.name,
              })),
            ]}
            onValueChange={(value) => navigate(chatPath(value))}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select agent or workflow" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agentTargetId(agent.id)}>
                  <span className="inline-flex items-center gap-2">
                    <Badge variant="secondary">agent</Badge>
                    {agent.name}
                  </span>
                </SelectItem>
              ))}
              {workflows.map((workflow) => (
                <SelectItem key={workflow.id} value={workflowTargetId(workflow.id)}>
                  <span className="inline-flex items-center gap-2">
                    <Badge variant="outline">workflow</Badge>
                    {workflow.manifest.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chatTarget ? (
            <span className="truncate font-mono text-xs text-muted-foreground">{chatTarget.url}</span>
          ) : null}
        </div>
      ) : null}

      {chatTarget ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <ChatPanel
            key={chatTarget.id}
            url={chatTarget.url}
            persistence={persistence}
            title={chatTarget.name}
            description={chatTarget.description}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            title="No agent to chat with"
            description={
              !hasTargets
                ? 'Create an agent or workflow first to start a conversation.'
                : 'Select an agent or workflow above to start chatting.'
            }
            action={
              !hasTargets ? (
                <Button render={<Link href={createAgentPath()} />}>
                  <Plus className="size-4" />
                  Create an agent
                </Button>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}
