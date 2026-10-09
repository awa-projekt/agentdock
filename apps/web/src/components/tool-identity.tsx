import { type ApprovalPrincipal, INTERNAL_INTEGRATION_SLUG, splitIntegrationToolId } from 'agentdock-sdk/schemas';
import { Bot, Command, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ToolDirectory } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { IntegrationIcon, integrationHost } from '@/views/integrations/IntegrationIcon';

export function ToolIdentity({
  toolId,
  directory,
  className,
}: {
  toolId: string | null;
  directory: ToolDirectory | undefined;
  className?: string;
}) {
  const tool = toolId === null ? undefined : directory?.tools.get(toolId);
  const toolName = tool?.name ?? (toolId === null ? null : (splitIntegrationToolId(toolId)?.tool ?? toolId));

  if (tool === undefined) {
    return (
      <span className={cn('flex min-w-0 flex-col gap-0.5', className)}>
        <span className="font-mono text-sm font-medium break-all">{toolName ?? 'Unknown tool'}</span>
        <span className="text-xs break-all text-muted-foreground">
          {toolId === null ? 'Connection unavailable' : (splitIntegrationToolId(toolId)?.alias ?? toolId)}
        </span>
      </span>
    );
  }

  const integration = directory?.integrations.find((entry) => entry.slug === tool.integration);
  const connection = integration?.connections.find(
    (entry) => entry.name === tool.connection.name && entry.owner.kind === tool.connection.owner,
  );
  const internal = tool.integration === INTERNAL_INTEGRATION_SLUG;
  const connectionLabel =
    connection?.identityLabel ?? (tool.connection.name === 'default' ? 'Default connection' : tool.connection.name);

  return (
    <span className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="font-mono text-sm font-medium break-all">{toolName}</span>
      <span className="flex min-w-0 items-center gap-2">
        {internal ? (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
            <Command className="size-3" />
          </span>
        ) : (
          <IntegrationIcon host={integrationHost(integration ?? { slug: tool.integration })} size={20} />
        )}
        <span className="truncate text-xs text-muted-foreground">
          {internal ? 'Agentdock' : (integration?.name ?? tool.integration)}
          {internal ? null : <> · {connectionLabel}</>}
        </span>
        {internal ? null : (
          <Badge variant="outline" className="shrink-0">
            {tool.connection.owner === 'org' ? 'Organization' : 'User'}
          </Badge>
        )}
      </span>
    </span>
  );
}

const principalIcon = {
  agent: Bot,
  workflow: Workflow,
  platform: Command,
} satisfies Record<ApprovalPrincipal['kind'], typeof Bot>;

export function PrincipalLabel({ principal }: { principal: ApprovalPrincipal | null }) {
  if (principal === null) return <span className="text-xs text-muted-foreground">Unknown caller</span>;
  const Icon = principalIcon[principal.kind];
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs" title={`${principal.kind} ${principal.id}`}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{principal.name}</span>
    </span>
  );
}
