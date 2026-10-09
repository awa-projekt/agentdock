import type { UseQueryResult } from '@tanstack/react-query';
import type { AgentInternalsResponse, AgentRecord } from 'agentdock-sdk/schemas';
import { ChevronDown, MessageSquare, Pencil, Plug, Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { DetailSkeleton, SplitSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { Markdown, MarkdownPreview } from '@/components/markdown';
import { SectionHeader } from '@/components/SectionHeader';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCommunication } from '@/lib/agent-form';
import { agentA2aUrl } from '@/lib/api';
import { formatInteger, formatList, toErrorMessage } from '@/lib/format';
import { useAgentInternals, useAgents, useRemoveAgent } from '@/lib/queries';
import {
  agentsPath,
  chatPath,
  createAgentPath,
  decodeRouteParam,
  editAgentPath,
  routePatterns,
  toolsPath,
} from '@/lib/routing';
import { agentTargetId } from '@/lib/targets';
import { cn } from '@/lib/utils';
import { AgentEditor } from '@/views/agents/AgentEditor';
import { AgentIcon } from '@/views/agents/AgentIcon';
import { AgentList } from '@/views/agents/AgentList';

type AgentsRoute =
  | { readonly mode: 'create' }
  | { readonly mode: 'edit'; readonly agentId: string | null }
  | { readonly mode: 'view'; readonly agentId: string | null };

const useAgentsRoute = (): AgentsRoute => {
  const [creating] = useRoute(routePatterns.createAgent);
  const [editing, editParams] = useRoute(routePatterns.editAgent);
  const [, viewParams] = useRoute(routePatterns.agents);
  if (creating) return { mode: 'create' };
  if (editing) return { mode: 'edit', agentId: decodeRouteParam(editParams.agentId) };
  return { mode: 'view', agentId: decodeRouteParam(viewParams?.agentId) };
};

export function AgentsView() {
  const [, navigate] = useLocation();
  const route = useAgentsRoute();
  const agentsQuery = useAgents();
  const removeAgent = useRemoveAgent();

  const agents = agentsQuery.data ?? [];
  const routeAgentId = route.mode === 'create' ? null : route.agentId;
  const routeAgent = agents.find((agent) => agent.id === routeAgentId) ?? null;
  const selectedAgent = route.mode === 'create' ? null : (routeAgent ?? agents[0] ?? null);

  useEffect(() => {
    if (agentsQuery.isPending || route.mode === 'create') return;
    if (selectedAgent && selectedAgent.id !== routeAgentId) navigate(agentsPath(selectedAgent.id), { replace: true });
  }, [agentsQuery.isPending, navigate, route.mode, routeAgentId, selectedAgent]);

  if (agentsQuery.isError) {
    return <ErrorBanner>{toErrorMessage(agentsQuery.error, 'Could not load agents.')}</ErrorBanner>;
  }

  if (!agentsQuery.isPending && agents.length === 0 && route.mode !== 'create') {
    return (
      <EmptyState
        title="No agents yet"
        description="Create your first agent to get started. It will be reachable through the A2A route immediately."
        action={
          <Button render={<Link href={createAgentPath()} />}>
            <Plus className="size-4" />
            Create your first agent
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <SectionHeader
        title="Agents"
        description={agentsQuery.isPending ? 'Loading agents…' : `${agents.length} registered`}
        actions={
          <Button render={<Link href={createAgentPath()} />}>
            <Plus className="size-4" />
            New agent
          </Button>
        }
      />
      {agentsQuery.isPending ? (
        <SplitSkeleton masterWidth="300px" />
      ) : (
        <MasterDetail
          masterWidth="300px"
          master={
            <AgentList
              agents={agents}
              selectedId={selectedAgent?.id ?? null}
              onSelect={(agentId) => navigate(agentsPath(agentId))}
            />
          }
          detail={
            route.mode === 'create' ? (
              <AgentEditor key="new" agent={null} />
            ) : route.mode === 'edit' && routeAgent ? (
              <AgentEditor key={routeAgent.id} agent={routeAgent} />
            ) : selectedAgent ? (
              <AgentDetail
                key={selectedAgent.id}
                agent={selectedAgent}
                isRemoving={removeAgent.isPending && removeAgent.variables === selectedAgent.id}
                onEdit={() => navigate(editAgentPath(selectedAgent.id))}
                onRemove={() => removeAgent.mutate(selectedAgent.id, { onSuccess: () => navigate(agentsPath()) })}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}

function AgentDetail({
  agent,
  isRemoving,
  onEdit,
  onRemove,
}: {
  agent: AgentRecord;
  isRemoving: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const internalsQuery = useAgentInternals(agent.id, true);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentIcon color={agent.color} className="size-11 rounded-lg" iconClassName="size-5" />
          <div className="min-w-0 space-y-1.5">
            <div className="truncate text-lg font-semibold">{agent.name}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="secondary" className="font-mono">
                {agent.model}
              </Badge>
              <Badge variant="outline">v{agent.version}</Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" render={<Link href={chatPath(agentTargetId(agent.id))} />}>
            <MessageSquare className="size-4" />
            Chat
          </Button>
          <Button size="icon-sm" variant="ghost" title="Manage tools" render={<Link href={toolsPath(agent.id)} />}>
            <Plug className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onEdit} title="Edit agent">
            <Pencil className="size-4" />
          </Button>
          <ConfirmButton
            size="icon-sm"
            variant="destructiveGhost"
            onConfirm={onRemove}
            disabled={isRemoving}
            title="Remove agent"
            description={`Remove ${agent.name} and its configuration?`}
          >
            <Trash2 className="size-4" />
          </ConfirmButton>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{agent.description}</p>

      <dl className="grid gap-x-6 gap-y-3 text-xs @lg:grid-cols-2">
        <DetailLine label="ID" value={agent.id} mono />
        <DetailLine label="A2A route" value={agentA2aUrl(agent.id)} mono />
        <DetailLine label="Integrations" value={formatList(Object.keys(agent.integrations))} />
        <DetailLine label="Can message" value={formatCommunication(agent)} />
        <DetailLine label="Inputs" value={formatList(agent.defaultInputModes)} />
        <DetailLine label="Outputs" value={formatList(agent.defaultOutputModes)} />
        <DetailLine
          label="Capabilities"
          value={`streaming · ${agent.capabilities.streaming ? 'on' : 'off'}, push · ${agent.capabilities.pushNotifications ? 'on' : 'off'}`}
        />
      </dl>

      {agent.instructions ? (
        <section>
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Instructions
          </div>
          <Markdown className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs leading-relaxed">
            {agent.instructions}
          </Markdown>
        </section>
      ) : null}

      <AgentInternalsPanel state={internalsQuery} />
    </div>
  );
}

function AgentInternalsPanel({ state }: { state: UseQueryResult<AgentInternalsResponse> }) {
  if (state.isLoading) {
    return <DetailSkeleton />;
  }

  if (state.isError) {
    return (
      <div className="text-xs text-destructive">
        Failed to load internals: {toErrorMessage(state.error, 'Unknown error')}
      </div>
    );
  }

  if (!state.data) return null;

  const internalTools = state.data.tools.filter((tool) => tool.source === 'internal');
  const integrationTools = state.data.tools.filter((tool) => tool.source === 'integration');
  const { tokenCount } = state.data.prompt;
  const { contextWindow, maxOutputTokens, provider, id: modelId } = state.data.model;
  const pct = contextWindow ? Math.min(100, (tokenCount / contextWindow) * 100) : null;
  const pctLabel = pct !== null ? `${pct < 1 && pct > 0 ? '<1' : pct.toFixed(pct < 10 ? 1 : 0)}%` : null;
  const barTone = pct === null ? 'bg-primary/60' : pct < 60 ? 'bg-success' : pct < 85 ? 'bg-warning' : 'bg-destructive';

  return (
    <div className="space-y-4 border-t border-border/60 pt-3">
      <section className="rounded-md border border-border/60 bg-background/60 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" />
            Context
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {provider}:{modelId}
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-foreground/90">
            <span className="font-mono text-sm font-semibold">{formatInteger(tokenCount)}</span>
            {contextWindow ? (
              <span className="text-[11px] text-muted-foreground">
                {' / '}
                {formatInteger(contextWindow)} tokens
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground"> tokens</span>
            )}
          </div>
          {pctLabel ? <div className="font-mono text-[11px] text-muted-foreground">{pctLabel}</div> : null}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-all', barTone)} style={{ width: `${pct ?? 0}%` }} />
        </div>
        {maxOutputTokens ? (
          <div className="mt-2 text-[10px] text-muted-foreground">
            Max output {formatInteger(maxOutputTokens)} tokens
          </div>
        ) : null}
      </section>

      <div className="grid gap-3 @2xl:grid-cols-2">
        <ToolList title="Internal tools" icon={<Wrench className="size-3" />} tools={internalTools} />
        <ToolList title="Executor tools" icon={<Plug className="size-3" />} tools={integrationTools} />
      </div>

      <PromptBlock title="Estimated final system prompt" value={state.data.prompt.finalInstructions || '—'} />
    </div>
  );
}

type ToolStatusLabel = NonNullable<AgentInternalsResponse['tools'][number]['mode']> | 'active' | 'inactive';

function ToolList({
  title,
  icon,
  tools,
}: {
  title: string;
  icon: ReactNode;
  tools: ReadonlyArray<AgentInternalsResponse['tools'][number]>;
}) {
  return (
    <section className="rounded-md border border-border/60 bg-background/60">
      <header className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {icon}
          {title}
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          {tools.length}
        </Badge>
      </header>
      <div className="max-h-72 overflow-y-auto p-2">
        {tools.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">None</div>
        ) : (
          <ul className="space-y-1.5">
            {tools.map((tool) => {
              const label: ToolStatusLabel = tool.mode ?? (tool.active ? 'active' : 'inactive');
              const dim = tool.mode === 'disabled' || (!tool.mode && !tool.active);
              return (
                <li
                  key={`${tool.source}:${tool.id}`}
                  className={cn(
                    'rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border/60 hover:bg-muted/40',
                    dim && 'opacity-60',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="break-all font-mono text-[11px] font-medium text-foreground">{tool.name}</span>
                    <Badge
                      variant={label === 'native' ? 'success' : label === 'codemode' ? 'outline' : 'secondary'}
                      className={cn(
                        'shrink-0 text-[9px] uppercase tracking-wider',
                        label === 'codemode' && 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
                      )}
                    >
                      {label}
                    </Badge>
                  </div>
                  {tool.description ? (
                    <MarkdownPreview lines={2} className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {tool.description}
                    </MarkdownPreview>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function PromptBlock({ title, value }: { title: string; value: string }) {
  return (
    <details className="group rounded-md border border-border/60 bg-background/60">
      <summary className="flex cursor-pointer items-center justify-between px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border/60 p-3 font-mono text-[11px] leading-relaxed">
        {value}
      </pre>
    </details>
  );
}

function DetailLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 break-words text-foreground/90', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}
