import {
  Activity,
  Bot,
  ChevronsLeft,
  ClipboardCheck,
  Command,
  Database,
  GitBranch,
  KeyRound,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Moon,
  Network,
  Plug,
  Rocket,
  ShieldQuestion,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useRoute } from 'wouter';
import { SidebarButton } from '@/components/sidebar-button';
import { Button } from '@/components/ui/button';
import { useSidebarCollapsed, useTheme } from '@/hooks/use-ui-preferences';
import type { AuthRole } from '@/lib/auth-client';
import { useAgents, useHealth, usePendingApprovals, useSkills, useTriggers, useWorkflows } from '@/lib/queries';
import {
  agentsPath,
  agentsSectionPattern,
  approvalsPath,
  channelsPath,
  chatPath,
  communicationPath,
  decodeRouteParam,
  evalsPath,
  integrationsPath,
  providersPath,
  routePatterns,
  setupPath,
  skillsPath,
  toolsPath,
  tracesPath,
  triggersPath,
  userIntegrationsPath,
  workflowsPath,
  workflowsSectionPattern,
} from '@/lib/routing';
import { cn } from '@/lib/utils';

export function Sidebar({
  role,
  userEmail,
  onSignOut,
}: {
  role: AuthRole;
  userEmail: string | null;
  onSignOut?: () => void;
}) {
  const [theme, toggleTheme] = useTheme();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const isAdmin = role === 'admin';

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden overscroll-contain border-r border-sidebar-border bg-sidebar py-5 transition-[width] duration-200',
        collapsed ? 'w-16 items-center px-2' : 'w-60 px-3',
      )}
    >
      <div className={cn('flex h-8 items-center', collapsed ? 'justify-center' : 'justify-between gap-2 pl-1')}>
        {collapsed ? null : (
          <div className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Command className="size-4" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-sidebar-foreground">Agentdock</div>
              <div className="text-[11px] text-muted-foreground">Control panel</div>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
        </Button>
      </div>

      <nav className={cn('mt-8 flex flex-col gap-1', collapsed && 'items-center')}>
        {isAdmin ? (
          <AdminNav collapsed={collapsed} />
        ) : (
          <NavItem
            collapsed={collapsed}
            icon={<Database className="size-4" />}
            label="Connections"
            href={userIntegrationsPath()}
            match={routePatterns.userIntegrations}
          />
        )}
      </nav>

      <div
        className={cn('mt-auto flex flex-col gap-1 border-t border-sidebar-border pt-3', collapsed && 'items-center')}
      >
        {userEmail && !collapsed ? (
          <div className="truncate px-2 text-xs text-muted-foreground">{userEmail}</div>
        ) : null}
        <HealthIndicator collapsed={collapsed} />
        <SidebarButton
          collapsed={collapsed}
          icon={theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          onClick={toggleTheme}
        />
        {onSignOut ? (
          <SidebarButton
            collapsed={collapsed}
            icon={<LogOut className="size-4" />}
            label="Sign out"
            onClick={onSignOut}
          />
        ) : null}
      </div>
    </aside>
  );
}

function Count({ value }: { value: number }) {
  return value > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{value}</span> : null;
}

function AttentionCount({ value }: { value: number }) {
  return value > 0 ? (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
      {value}
    </span>
  ) : null;
}

function NavSection({ collapsed, label }: { collapsed: boolean; label: string }) {
  if (collapsed) {
    return <span aria-hidden className="my-2 h-px w-6 shrink-0 bg-sidebar-border/60" />;
  }

  return (
    <div className="mt-5 mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
      {label}
    </div>
  );
}

function AdminNav({ collapsed }: { collapsed: boolean }) {
  const [, chatParams] = useRoute(routePatterns.chat);
  const [, toolsParams] = useRoute(routePatterns.tools);
  const agents = useAgents();
  const workflows = useWorkflows();
  const skills = useSkills();
  const triggers = useTriggers();
  const approvals = usePendingApprovals();

  return (
    <>
      <NavItem
        collapsed={collapsed}
        icon={<Rocket className="size-4" />}
        label="Setup"
        href={setupPath()}
        match={routePatterns.setup}
      />
      <NavItem
        collapsed={collapsed}
        icon={<MessageSquare className="size-4" />}
        label="Chat"
        href={chatPath(decodeRouteParam(chatParams?.agentId))}
        match={routePatterns.chat}
      />
      <NavItem
        collapsed={collapsed}
        icon={<ShieldQuestion className="size-4" />}
        label="Approvals"
        href={approvalsPath()}
        match={routePatterns.approvals}
        trailing={<AttentionCount value={approvals.data?.approvals.length ?? 0} />}
      />

      <NavSection collapsed={collapsed} label="Build" />
      <NavItem
        collapsed={collapsed}
        icon={<Bot className="size-4" />}
        label="Agents"
        href={agentsPath()}
        match={agentsSectionPattern}
        trailing={<Count value={agents.data?.length ?? 0} />}
      />
      <NavItem
        collapsed={collapsed}
        icon={<Network className="size-4" />}
        label="Communication"
        href={communicationPath()}
        match={routePatterns.communication}
      />
      <NavItem
        collapsed={collapsed}
        icon={<Sparkles className="size-4" />}
        label="Skills"
        href={skillsPath()}
        match={routePatterns.skills}
        trailing={<Count value={skills.data?.length ?? 0} />}
      />
      <NavItem
        collapsed={collapsed}
        icon={<Plug className="size-4" />}
        label="Tools"
        href={toolsPath(decodeRouteParam(toolsParams?.agentId))}
        match={routePatterns.tools}
      />

      <NavSection collapsed={collapsed} label="Automate" />
      <NavItem
        collapsed={collapsed}
        icon={<GitBranch className="size-4" />}
        label="Workflows"
        href={workflowsPath()}
        match={workflowsSectionPattern}
        trailing={<Count value={workflows.data?.length ?? 0} />}
      />
      <NavItem
        collapsed={collapsed}
        icon={<Zap className="size-4" />}
        label="Triggers"
        href={triggersPath()}
        match={routePatterns.triggers}
        trailing={<Count value={triggers.data?.length ?? 0} />}
      />
      <NavItem
        collapsed={collapsed}
        icon={<MessagesSquare className="size-4" />}
        label="Channels"
        href={channelsPath()}
        match={routePatterns.channels}
      />

      <NavSection collapsed={collapsed} label="Observe" />
      <NavItem
        collapsed={collapsed}
        icon={<Activity className="size-4" />}
        label="Traces"
        href={tracesPath()}
        match={routePatterns.traces}
      />
      <NavItem
        collapsed={collapsed}
        icon={<ClipboardCheck className="size-4" />}
        label="Evals"
        href={evalsPath()}
        match={routePatterns.evals}
      />

      <NavSection collapsed={collapsed} label="Settings" />
      <NavItem
        collapsed={collapsed}
        icon={<KeyRound className="size-4" />}
        label="Providers"
        href={providersPath()}
        match={routePatterns.providers}
      />
      <NavItem
        collapsed={collapsed}
        icon={<Database className="size-4" />}
        label="Integrations"
        href={integrationsPath()}
        match={routePatterns.integrations}
      />
    </>
  );
}

function NavItem({
  collapsed,
  icon,
  label,
  href,
  match,
  trailing,
}: {
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  href: string;
  match: string | RegExp;
  trailing?: ReactNode;
}) {
  const [active] = useRoute(match);

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center rounded-md text-sm transition-colors',
        collapsed ? 'size-10 justify-center' : 'h-9 justify-between px-2',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
      )}
    >
      <span className={cn('flex items-center', !collapsed && 'gap-2')}>
        <span className={cn('text-muted-foreground', active && 'text-primary')}>{icon}</span>
        {collapsed ? null : <span className="font-medium">{label}</span>}
      </span>
      {!collapsed && trailing}
    </Link>
  );
}

function HealthIndicator({ collapsed }: { collapsed: boolean }) {
  const health = useHealth();
  const isHealthy = health.data === 'OK';
  const dotClass = cn(
    'inline-flex size-2 rounded-full',
    isHealthy
      ? 'bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_25%,transparent)]'
      : health.isPending
        ? 'animate-pulse bg-muted-foreground/50'
        : 'bg-destructive',
  );
  const labelText = isHealthy
    ? 'API healthy'
    : health.isPending
      ? 'Checking API…'
      : health.isError
        ? 'API offline'
        : 'API unknown';

  if (collapsed) {
    return (
      <div className="flex size-10 items-center justify-center" title={labelText}>
        <span className={dotClass} />
      </div>
    );
  }

  return (
    <div className="flex h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
      <span className={dotClass} />
      <span>{labelText}</span>
    </div>
  );
}
