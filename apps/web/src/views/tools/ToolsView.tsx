import type {
  AgentRecord,
  AgentToolView,
  IntegrationSlug,
  IntegrationsResponse,
  IntegrationToolMode,
  UnresolvedAgentTool,
} from 'agentdock-sdk/schemas';
import { IntegrationToolId } from 'agentdock-sdk/schemas';
import { AlertTriangle, Boxes, FileJson, Hammer, Play, Plus, Trash2, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { EmptyState } from '@/components/EmptyState';
import { DetailSkeleton, SplitSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { MarkdownPreview } from '@/components/markdown';
import { SectionHeader } from '@/components/SectionHeader';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { SchemaExplorer } from '@/components/schema-explorer';
import { ToolRunner } from '@/components/tool-runner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { agentToForm } from '@/lib/agent-form';
import { type IntegrationChoice, withIntegrationChoice, withToolMode } from '@/lib/agent-tools';
import { toErrorMessage } from '@/lib/format';
import { useAgents, useAgentTools, useIntegrations, useUpdateAgent } from '@/lib/queries';
import { createAgentPath, decodeRouteParam, integrationsPath, type routePatterns, toolsPath } from '@/lib/routing';
import { AgentIcon } from '@/views/agents/AgentIcon';
import { AgentList } from '@/views/agents/AgentList';
import { ToolModeSwitch } from '@/views/integrations/ToolModeSwitch';

type ToolGroup = {
  readonly slug: IntegrationSlug;
  readonly name: string;
  readonly tools: ReadonlyArray<AgentToolView>;
};

/** An integration reached through the organisation's connection, or through each user's own. */
type AddChoice =
  | { readonly kind: 'integration'; readonly id: string; readonly mode: Exclude<IntegrationChoice, 'off'> }
  | { readonly kind: 'tool'; readonly id: IntegrationToolId };

const encodeAddChoice = (choice: AddChoice): string =>
  choice.kind === 'tool' ? `tool:${choice.id}` : `integration:${choice.mode}:${choice.id}`;

const decodeAddChoice = (value: string): AddChoice | null => {
  const [kind, ...rest] = value.split(':');
  if (kind === 'tool') {
    const id = rest.join(':');
    return id ? { kind, id: IntegrationToolId.make(id) } : null;
  }
  if (kind !== 'integration') return null;
  const [mode, ...idParts] = rest;
  const id = idParts.join(':');
  if (!id || (mode !== 'org' && mode !== 'user')) return null;
  return { kind, id, mode };
};

const pluralTools = (count: number): string => `${count} ${count === 1 ? 'tool' : 'tools'}`;

const groupByIntegration = (
  integrations: IntegrationsResponse['integrations'],
  tools: ReadonlyArray<AgentToolView>,
): ReadonlyArray<ToolGroup> => {
  const nameBySlug = new Map(integrations.map((integration) => [integration.slug, integration.name]));
  const groups = new Map<IntegrationSlug, Array<AgentToolView>>();
  for (const tool of tools) {
    const existing = groups.get(tool.integration);
    if (existing) existing.push(tool);
    else groups.set(tool.integration, [tool]);
  }
  return [...groups.entries()].map(([slug, grouped]) => ({
    slug,
    name: nameBySlug.get(slug) ?? slug,
    tools: grouped,
  }));
};

export function ToolsView() {
  const [, navigate] = useLocation();
  const params = useParams<typeof routePatterns.tools>();
  const routeAgentId = decodeRouteParam(params.agentId);
  const agentsQuery = useAgents();
  const agents = agentsQuery.data ?? [];
  const selectedAgent = agents.find((agent) => agent.id === routeAgentId) ?? agents[0] ?? null;

  useEffect(() => {
    if (selectedAgent && selectedAgent.id !== routeAgentId) navigate(toolsPath(selectedAgent.id), { replace: true });
  }, [navigate, routeAgentId, selectedAgent]);

  if (agentsQuery.isError) {
    return <ErrorBanner>{toErrorMessage(agentsQuery.error, 'Could not load agents.')}</ErrorBanner>;
  }

  if (!agentsQuery.isPending && !selectedAgent) {
    return (
      <EmptyState
        title="No agents for tools"
        description="Create an agent first, then add integrations and assign their tools."
        action={
          <Button render={<Link href={createAgentPath()} />}>
            <Plus className="size-4" />
            Create an agent
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <SectionHeader title="Agent tools" description="Select an agent, then add tools from registered integrations." />
      {agentsQuery.isPending || !selectedAgent ? (
        <SplitSkeleton masterWidth="300px" />
      ) : (
        <MasterDetail
          masterWidth="300px"
          master={
            <AgentList
              agents={agents}
              selectedId={selectedAgent.id}
              onSelect={(agentId) => navigate(toolsPath(agentId))}
            />
          }
          detail={<AgentToolsDetail key={selectedAgent.id} agent={selectedAgent} />}
        />
      )}
    </div>
  );
}

function AgentToolsDetail({ agent }: { agent: AgentRecord }) {
  const integrationsQuery = useIntegrations();
  const toolsQuery = useAgentTools(agent.id);
  const updateAgent = useUpdateAgent();
  const [addingTool, setAddingTool] = useState(false);

  const busy = updateAgent.isPending;
  const save = (integrations: AgentRecord['integrations'], onSuccess?: () => void) =>
    updateAgent.mutate({ agentId: agent.id, input: { ...agentToForm(agent), integrations } }, { onSuccess });

  const loadError = integrationsQuery.error ?? toolsQuery.error;
  if (loadError) return <ErrorBanner>{toErrorMessage(loadError, 'Could not load integrations.')}</ErrorBanner>;
  if (integrationsQuery.isPending || toolsQuery.isPending) return <DetailSkeleton />;

  const tools = toolsQuery.data?.tools ?? [];
  const unresolved = toolsQuery.data?.unresolved ?? [];
  const integrations = integrationsQuery.data?.integrations ?? [];
  const catalog = { integrations, tools };

  const updateToolMode = (toolId: IntegrationToolId, mode: IntegrationToolMode, onSuccess?: () => void) => {
    const tool = tools.find((candidate) => candidate.id === toolId);
    if (tool) save(withToolMode(agent.integrations, catalog, tool, mode), onSuccess);
  };

  const updateIntegrationMode = (slug: string, choice: IntegrationChoice, onSuccess?: () => void) =>
    save(withIntegrationChoice(agent.integrations, catalog, slug, choice), onSuccess);

  const assignedTools = tools.filter((tool) => tool.mode !== 'disabled');
  const availableTools = tools.filter((tool) => tool.mode === 'disabled');
  const groups = groupByIntegration(integrations, assignedTools);
  const availableGroups = groupByIntegration(integrations, availableTools);

  if (integrations.length === 0) {
    return (
      <EmptyState
        title="No integrations"
        description="Add an integration first, then assign its tools to this agent."
        action={
          <Button render={<Link href={integrationsPath()} />}>
            <Plus className="size-4" />
            Add integration
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <AgentIcon color={agent.color} className="size-11 rounded-lg" iconClassName="size-5" />
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{agent.name}</div>
            <div className="text-xs text-muted-foreground">
              {pluralTools(assignedTools.length)} across {groups.length}{' '}
              {groups.length === 1 ? 'integration' : 'integrations'}
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setAddingTool(true)}
          disabled={availableTools.length === 0 || addingTool}
        >
          <Plus className="size-4" />
          Add tool
        </Button>
      </div>

      {updateAgent.isError ? (
        <ErrorBanner>{toErrorMessage(updateAgent.error, 'Could not update the agent.')}</ErrorBanner>
      ) : null}

      {unresolved.length > 0 ? <UnresolvedList entries={unresolved} /> : null}

      {addingTool ? (
        <AddToolPanel
          availableGroups={availableGroups}
          pending={busy}
          onCancel={() => setAddingTool(false)}
          onAdd={(choice) => {
            const close = () => setAddingTool(false);
            if (choice.kind === 'integration') updateIntegrationMode(choice.id, choice.mode, close);
            else updateToolMode(choice.id, 'codemode', close);
          }}
        />
      ) : null}

      {groups.length > 0 ? (
        groups.map((group) => (
          <section key={group.slug} className="overflow-hidden rounded-lg border border-border">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Boxes className="size-4 shrink-0 text-muted-foreground" />
                <h3 className="truncate text-sm font-semibold" title={group.name}>
                  {group.name}
                </h3>
                <Badge variant="secondary" className="shrink-0">
                  {pluralTools(group.tools.length)}
                </Badge>
                <span className="hidden truncate font-mono text-[11px] text-muted-foreground lg:inline">
                  {group.slug}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructiveGhost"
                disabled={busy}
                onClick={() => updateIntegrationMode(group.slug, 'off')}
              >
                <Trash2 className="size-4" />
                Remove all
              </Button>
            </header>
            <ul className="divide-y divide-border/70">
              {group.tools.map((tool) => (
                <li key={tool.id}>
                  <ToolRow
                    tool={tool}
                    busy={busy}
                    onModeChange={(mode) => updateToolMode(tool.id, mode)}
                    onRemove={() => updateToolMode(tool.id, 'disabled')}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <EmptyState
          title="No tools added"
          description={`Add a tool from one of the registered integrations for ${agent.name}.`}
          action={
            availableTools.length > 0 && !addingTool ? (
              <Button type="button" onClick={() => setAddingTool(true)}>
                <Plus className="size-4" />
                Add tool
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

type ToolPanel = 'inspect' | 'test';

function UnresolvedList({ entries }: { entries: ReadonlyArray<UnresolvedAgentTool> }) {
  return (
    <section className="rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="size-4 text-warning" />
        Declared but not available
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        The agent config names these, but this server cannot serve them yet.
      </p>
      <ul className="mt-3 space-y-1.5 text-xs">
        {entries.map((entry) => (
          <li key={`${entry.integration}:${entry.tool ?? ''}:${entry.reason}`} className="flex items-start gap-2">
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {entry.reason}
            </Badge>
            <span className="min-w-0">
              {entry.message}
              {entry.reason === 'oauth-required' && entry.slug ? (
                <>
                  {' '}
                  <Link href={integrationsPath()} className="underline">
                    Connect it
                  </Link>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolRow({
  tool,
  busy,
  onModeChange,
  onRemove,
}: {
  tool: AgentToolView;
  busy: boolean;
  onModeChange: (mode: IntegrationToolMode) => void;
  onRemove: () => void;
}) {
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const togglePanel = (next: ToolPanel) => setPanel((current) => (current === next ? null : next));

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs font-semibold" title={tool.name}>
              {tool.name}
            </span>
            {tool.delegated ? (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                <UserRound className="size-3" />
                user account
              </Badge>
            ) : null}
            {tool.decision === 'require_approval' ? (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                needs approval
              </Badge>
            ) : null}
          </div>
          {tool.description ? (
            <MarkdownPreview lines={3} className="mt-1.5 text-sm text-muted-foreground">
              {tool.description}
            </MarkdownPreview>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <ToolPanelToggle active={panel === 'inspect'} onClick={() => togglePanel('inspect')}>
              <FileJson className="size-3.5" />
              Schema
            </ToolPanelToggle>
            <ToolPanelToggle active={panel === 'test'} onClick={() => togglePanel('test')}>
              <Play className="size-3.5" />
              Test
            </ToolPanelToggle>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ToolModeSwitch mode={tool.mode} disabled={busy} onChange={onModeChange} />
          <Button
            type="button"
            size="icon-sm"
            variant="destructiveGhost"
            disabled={busy}
            onClick={onRemove}
            title="Remove tool"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {panel === 'inspect' ? (
        <div className="mt-3 grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 @3xl:grid-cols-2">
          <SchemaExplorer schema={tool.inputSchema} title="Input schema" />
          <SchemaExplorer schema={tool.outputSchema} title="Output schema" />
        </div>
      ) : panel === 'test' ? (
        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3">
          <ToolRunner tool={tool} />
        </div>
      ) : null}
    </div>
  );
}

function ToolPanelToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" size="sm" variant={active ? 'outline' : 'ghost'} onClick={onClick}>
      {children}
    </Button>
  );
}

function AddToolPanel({
  availableGroups,
  pending,
  onCancel,
  onAdd,
}: {
  availableGroups: ReadonlyArray<ToolGroup>;
  pending: boolean;
  onCancel: () => void;
  onAdd: (choice: AddChoice) => void;
}) {
  const [selected, setSelected] = useState('');
  const choice = decodeAddChoice(selected);

  return (
    <section className="space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div>
        <h3 className="text-sm font-semibold">Add tools</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Pick a whole integration or a single tool. Single tools start as discoverable.
        </p>
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Integrations</div>
        <div className="grid gap-2 md:grid-cols-2">
          {availableGroups
            .flatMap((group) => {
              const shared = group.tools.filter((tool) => !tool.delegated);
              const delegated = group.tools.filter((tool) => tool.delegated);
              return [
                ...(shared.length === 0
                  ? []
                  : [
                      {
                        value: encodeAddChoice({ kind: 'integration', id: group.slug, mode: 'org' }),
                        title: group.name,
                        detail: `Add ${pluralTools(shared.length)} on the shared connection`,
                      },
                    ]),
                ...(delegated.length === 0
                  ? []
                  : [
                      {
                        value: encodeAddChoice({ kind: 'integration', id: group.slug, mode: 'user' }),
                        title: `${group.name} — each user's own account`,
                        detail: `Add ${pluralTools(delegated.length)}, each call acting for the calling user`,
                      },
                    ]),
              ];
            })
            .map((option) => (
              <AddChoiceOption
                key={option.value}
                kind="integration"
                title={option.title}
                detail={option.detail}
                selected={selected === option.value}
                onSelect={() => setSelected(option.value)}
              />
            ))}
        </div>
      </div>
      {availableGroups.map((group) => (
        <div key={group.slug}>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{group.name}</div>
          <div className="grid max-h-80 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
            {group.tools.map((tool) => {
              const value = encodeAddChoice({ kind: 'tool', id: tool.id });
              return (
                <AddChoiceOption
                  key={value}
                  kind="tool"
                  title={tool.name}
                  detail={tool.description}
                  selected={selected === value}
                  onSelect={() => setSelected(value)}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!choice || pending} onClick={() => choice && onAdd(choice)}>
          Add selected
        </Button>
      </div>
    </section>
  );
}

function AddChoiceOption({
  kind,
  title,
  detail,
  selected,
  onSelect,
}: {
  kind: 'integration' | 'tool';
  title: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = kind === 'integration' ? Boxes : Hammer;
  return (
    <SelectableCard onClick={onSelect} active={selected} className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block truncate text-sm font-medium">{title}</span>
        <MarkdownPreview lines={1} className="text-xs text-muted-foreground">
          {detail}
        </MarkdownPreview>
      </span>
    </SelectableCard>
  );
}
