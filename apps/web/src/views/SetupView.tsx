import type { McpAccessResponse } from 'agentdock-sdk/schemas';
import { Bot, CheckIcon, CopyIcon, TerminalSquare, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useLocation } from 'wouter';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { FormSection } from '@/components/form';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCopy } from '@/hooks/use-copy';
import { useWorkspaceMode, type WorkspaceMode } from '@/hooks/use-ui-preferences';
import { formatDateTime, toErrorMessage } from '@/lib/format';
import { useMcpAccess, useRevokeMcpGrant } from '@/lib/queries';
import { agentsPath } from '@/lib/routing';
import { cn } from '@/lib/utils';
import { IntegrationIcon } from '@/views/integrations/IntegrationIcon';

const SERVER_NAME = 'agentdock';
const SKILL_NAME = 'agentdock';

type Harness = 'claude-code' | 'codex' | 'opencode' | 'other';

type HarnessSetup = {
  readonly label: string;
  /** Where the harness's logo is looked up; the generic plug icon stands in without one. */
  readonly host?: string;
  readonly skill: string;
  readonly server: { readonly title: string; readonly code: string };
  readonly authenticate: { readonly code?: string; readonly hint: string };
};

const harnessSetup = (harness: Harness, { mcpUrl, skillsUrl }: McpAccessResponse): HarnessSetup => {
  const installSkill = (agent?: string) =>
    `npx skills add ${skillsUrl} --skill ${SKILL_NAME} -g${agent ? ` -a ${agent} -y` : ''}`;
  switch (harness) {
    case 'claude-code':
      return {
        label: 'Claude Code',
        host: 'claude.ai',
        skill: installSkill('claude-code'),
        server: {
          title: 'Add the MCP server',
          code: `claude mcp add --scope user --transport http ${SERVER_NAME} ${mcpUrl}`,
        },
        authenticate: { hint: 'Run /mcp in Claude Code, pick agentdock and choose Authenticate.' },
      };
    case 'codex':
      return {
        label: 'Codex',
        host: 'openai.com',
        skill: installSkill('codex'),
        server: { title: 'Add the MCP server', code: `codex mcp add ${SERVER_NAME} --url ${mcpUrl}` },
        authenticate: { code: `codex mcp login ${SERVER_NAME}`, hint: 'The login command opens your browser.' },
      };
    case 'opencode':
      return {
        label: 'OpenCode',
        host: 'opencode.ai',
        skill: installSkill('opencode'),
        server: {
          title: 'Add the MCP server to ~/.config/opencode/opencode.json',
          code: JSON.stringify(
            { $schema: 'https://opencode.ai/config.json', mcp: { [SERVER_NAME]: { type: 'remote', url: mcpUrl } } },
            null,
            2,
          ),
        },
        authenticate: { code: `opencode mcp auth ${SERVER_NAME}`, hint: 'The auth command opens your browser.' },
      };
    case 'other':
      return {
        label: 'Other',
        skill: installSkill(),
        server: {
          title: 'Add the MCP server to your client configuration',
          code: JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl } } }, null, 2),
        },
        authenticate: { hint: 'Your client opens the browser to sign in the first time it connects.' },
      };
  }
};

const HARNESSES: ReadonlyArray<Harness> = ['claude-code', 'codex', 'opencode', 'other'];

/**
 * The dashboard's landing page: the person chooses whether they operate this
 * instance through their own coding agent over MCP or through the built-in
 * assistant, and can come back here to switch.
 */
export function SetupView() {
  const [mode, setMode] = useWorkspaceMode();
  const [, navigate] = useLocation();

  const choose = (next: WorkspaceMode) => {
    setMode(next);
    if (next === 'assistant') navigate(agentsPath());
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Set up Agentdock"
        description="Choose how you build and operate agents here. You can switch at any time from this page."
      />

      <div className="grid gap-3 md:grid-cols-2">
        <ModeCard
          active={mode === 'external'}
          icon={<TerminalSquare className="size-5" />}
          title="Use your coding agent"
          description="Connect Claude Code, Codex, OpenCode or any MCP client. The dashboard hides the assistant and gives pages the full width."
          onClick={() => choose('external')}
        />
        <ModeCard
          active={mode === 'assistant'}
          icon={<Bot className="size-5" />}
          title="Use the built-in assistant"
          description="Chat with the Agentdock assistant beside every page. Nothing to install; it runs on this server's models."
          onClick={() => choose('assistant')}
        />
      </div>

      {mode === 'external' ? <CodingAgentSetup /> : null}
    </div>
  );
}

function ModeCard({
  active,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <SelectableCard active={active} onClick={onClick} className="p-4">
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 text-muted-foreground', active && 'text-primary')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-semibold">
            {title}
            {active ? <Badge variant="secondary">Current</Badge> : null}
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
        </span>
      </div>
    </SelectableCard>
  );
}

function CodingAgentSetup() {
  const access = useMcpAccess();
  const [harness, setHarness] = useState<Harness>('claude-code');

  if (access.isPending) return <ListSkeleton />;
  if (access.isError) return <ErrorBanner>{toErrorMessage(access.error, 'Failed to load MCP access.')}</ErrorBanner>;

  const setup = harnessSetup(harness, access.data);

  return (
    <div className="space-y-8">
      <FormSection
        title="Connect your coding agent"
        description="The agentdock skill teaches your agent how Agentdock works; the MCP server gives it the tools. You sign in through the browser as yourself, so there is no API key to manage."
      >
        <Tabs value={harness} onValueChange={setHarness}>
          <TabsList>
            {HARNESSES.map((candidate) => {
              const { label, host } = harnessSetup(candidate, access.data);
              return (
                <TabsTrigger key={candidate} value={candidate} className="gap-1.5">
                  <IntegrationIcon host={host} size={14} />
                  {label}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <TabsContent value={harness} className="space-y-5">
            <Step number={1} title="Install the skill">
              <CommandBlock code={setup.skill} />
            </Step>
            <Step number={2} title={setup.server.title}>
              <CommandBlock code={setup.server.code} />
            </Step>
            <Step number={3} title="Sign in">
              {setup.authenticate.code ? <CommandBlock code={setup.authenticate.code} /> : null}
              <p className="text-sm text-muted-foreground">
                {setup.authenticate.hint} Approve the request in this dashboard when it asks.
              </p>
            </Step>
          </TabsContent>
        </Tabs>
      </FormSection>

      <ConnectedClients grants={access.data.grants} />
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}

function CommandBlock({ code }: { code: string }) {
  const [copied, copy] = useCopy(code);
  return (
    <div className="relative rounded-lg border border-border bg-muted/40">
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-relaxed">{code}</pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-2"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
      </Button>
    </div>
  );
}

function ConnectedClients({ grants }: { grants: McpAccessResponse['grants'] }) {
  const revoke = useRevokeMcpGrant();

  return (
    <FormSection title="Connected clients" description="Programs you authorized to operate Agentdock over MCP.">
      {revoke.isError ? <ErrorBanner>{toErrorMessage(revoke.error, 'Failed to revoke access.')}</ErrorBanner> : null}
      {grants.length === 0 ? (
        <EmptyState title="No clients connected" description="Clients show up here once you approve their sign-in." />
      ) : (
        <div className="grid gap-2">
          {grants.map((grant) => (
            <div key={grant.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{grant.clientName}</div>
                <div className="text-xs text-muted-foreground">
                  Connected {formatDateTime(grant.createdAt)}
                  {grant.lastUsedAt === null ? '' : ` · last used ${formatDateTime(grant.lastUsedAt)}`}
                </div>
              </div>
              <ConfirmButton
                size="icon-sm"
                variant="destructiveGhost"
                disabled={revoke.isPending}
                onConfirm={() => revoke.mutate(grant.id)}
                title="Revoke access"
                description={`${grant.clientName} loses access immediately and has to sign in again.`}
              >
                <Trash2 className="size-4" />
              </ConfirmButton>
            </div>
          ))}
        </div>
      )}
    </FormSection>
  );
}
