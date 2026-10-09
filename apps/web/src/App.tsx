import { useQueryClient } from '@tanstack/react-query';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { lazy, type ReactNode, Suspense, useCallback, useEffect } from 'react';
import { Redirect, Route, Switch, useLocation, useRoute, useSearch } from 'wouter';
import { AssistantWorkspace } from '@/components/AssistantWorkspace';
import { BootScreen } from '@/components/BootScreen';
import { ScreenSkeleton } from '@/components/Loading';
import { Sidebar } from '@/components/Sidebar';
import { AgentDraftProvider } from '@/hooks/use-agent-draft';
import { useWorkspaceMode, type WorkspaceMode } from '@/hooks/use-ui-preferences';
import { type AuthRole, authClient } from '@/lib/auth-client';
import { queryKeys, useServerEvents } from '@/lib/queries';
import { agentsPath, communicationPath, routePatterns, setupPath, userIntegrationsPath } from '@/lib/routing';
import { AuthView } from '@/views/AuthView';
import { AgentsView } from '@/views/agents/AgentsView';
import { ChannelsView } from '@/views/ChannelsView';
import { DeviceAuthorizationView } from '@/views/DeviceAuthorizationView';
import { OAuthConsentView } from '@/views/OAuthConsentView';
import { ProvidersView } from '@/views/ProvidersView';
import { SetupView } from '@/views/SetupView';
import { SkillsView } from '@/views/SkillsView';
import { TriggersView } from '@/views/TriggersView';

// Lazy views keep the initial bundle small, but the first click on one of these
// tabs otherwise pays a chunk-fetch (~0.5s) that the eagerly-imported tabs above
// don't. `prefetchLazyViews` warms every chunk once the app is idle so tab
// switches feel instant.
const importAgentGraphView = () =>
  import('@/views/AgentGraphView').then((module) => ({ default: module.AgentGraphView }));
const importChatView = () => import('@/views/ChatView').then((module) => ({ default: module.ChatView }));
const importEvalsView = () => import('@/views/evals/EvalsView').then((module) => ({ default: module.EvalsView }));
const importIntegrationsView = () =>
  import('@/views/integrations/IntegrationsView').then((module) => ({ default: module.IntegrationsView }));
const importUserIntegrationsView = () =>
  import('@/views/UserIntegrationsView').then((module) => ({ default: module.UserIntegrationsView }));
const importApprovalsView = () => import('@/views/ApprovalsView').then((module) => ({ default: module.ApprovalsView }));
const importToolsView = () => import('@/views/tools/ToolsView').then((module) => ({ default: module.ToolsView }));
const importTracesView = () => import('@/views/TracesView').then((module) => ({ default: module.TracesView }));
const importWorkflowsView = () => import('@/views/WorkflowsView').then((module) => ({ default: module.WorkflowsView }));

const AgentGraphView = lazy(importAgentGraphView);
const ChatView = lazy(importChatView);
const EvalsView = lazy(importEvalsView);
const IntegrationsView = lazy(importIntegrationsView);
const UserIntegrationsView = lazy(importUserIntegrationsView);
const ApprovalsView = lazy(importApprovalsView);
const ToolsView = lazy(importToolsView);
const TracesView = lazy(importTracesView);
const WorkflowsView = lazy(importWorkflowsView);

const prefetchLazyViews = () => {
  void importAgentGraphView();
  void importChatView();
  void importEvalsView();
  void importIntegrationsView();
  void importUserIntegrationsView();
  void importApprovalsView();
  void importToolsView();
  void importTracesView();
  void importWorkflowsView();
};

/** Stretches to the viewport and lets the view own its scroll container. */
function FillLayout({
  children,
  layout = 'split',
  masterWidth,
}: {
  children: ReactNode;
  layout?: 'split' | 'chat' | 'graph' | 'list' | 'workflow-registry' | 'workflow-runs';
  masterWidth?: string;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-full min-h-0 w-full flex-col px-4 py-6 md:px-6 md:py-6">
        <Suspense fallback={<ScreenSkeleton layout={layout} masterWidth={masterWidth} />}>{children}</Suspense>
      </div>
    </main>
  );
}

/** Centred document that scrolls as a whole. */
function PageLayout({ children, layout = 'list' }: { children: ReactNode; layout?: 'list' | 'integration' }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-10">
        <Suspense fallback={<ScreenSkeleton layout={layout} />}>{children}</Suspense>
      </div>
    </main>
  );
}

const authDisabled = globalThis.__AGENTDOCK_DISABLE_AUTH__ === true;

const roleFromSessionUser = (user: { readonly role?: unknown }): AuthRole => (user.role === 'admin' ? 'admin' : 'user');

function ServerEvents() {
  useServerEvents();
  return null;
}

export function App() {
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const [, navigate] = useLocation();
  const [isDeviceRoute] = useRoute(routePatterns.device);
  const [isConsentRoute] = useRoute(routePatterns.oauthConsent);
  const [isSetupRoute] = useRoute(routePatterns.setup);
  const [workspaceMode] = useWorkspaceMode();
  const search = useSearch();
  const authRole = authDisabled ? 'admin' : session.data ? roleFromSessionUser(session.data.user) : 'user';
  const isAdmin = authRole === 'admin';

  useEffect(() => {
    const ric = globalThis.requestIdleCallback;
    if (ric) {
      const id = ric(prefetchLazyViews);
      return () => globalThis.cancelIdleCallback?.(id);
    }
    const fiber = Effect.runFork(Effect.delay(Effect.sync(prefetchLazyViews), '200 millis'));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    await queryClient.clear();
    navigate(agentsPath());
  }, [navigate, queryClient]);

  if (!authDisabled && session.isPending) {
    return <BootScreen />;
  }

  if (!authDisabled && !session.data) {
    return (
      <AuthView
        onAuthenticated={() => {
          void session.refetch();
          void queryClient.invalidateQueries({ queryKey: queryKeys.health });
        }}
      />
    );
  }

  if (isDeviceRoute) {
    return (
      <DeviceAuthorizationView
        initialUserCode={new URLSearchParams(search).get('user_code')}
        userEmail={authDisabled ? null : (session.data?.user.email ?? null)}
        onDone={() => navigate(isAdmin ? agentsPath() : userIntegrationsPath())}
      />
    );
  }

  if (isConsentRoute) {
    return (
      <OAuthConsentView
        requestId={new URLSearchParams(search).get('request') ?? ''}
        userEmail={authDisabled ? null : (session.data?.user.email ?? null)}
      />
    );
  }

  return (
    <AgentDraftProvider>
      <ServerEvents />
      <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
        <Sidebar
          role={authRole}
          userEmail={authDisabled ? 'Auth disabled' : (session.data?.user.email ?? null)}
          onSignOut={authDisabled ? undefined : () => void handleSignOut()}
        />

        {isAdmin && workspaceMode === 'assistant' && !isSetupRoute ? (
          <AssistantWorkspace>
            <AdminRoutes access={authRole} workspaceMode={workspaceMode} />
          </AssistantWorkspace>
        ) : isAdmin ? (
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <AdminRoutes access={authRole} workspaceMode={workspaceMode} />
          </div>
        ) : (
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <UserRoutes />
          </div>
        )}
      </div>
    </AgentDraftProvider>
  );
}

function AdminRoutes({ access, workspaceMode }: { access: AuthRole; workspaceMode: WorkspaceMode | null }) {
  return (
    <Switch>
      <Route path={routePatterns.setup}>
        <PageLayout>
          <SetupView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.createAgent}>
        <FillLayout masterWidth="300px">
          <AgentsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.editAgent}>
        <FillLayout masterWidth="300px">
          <AgentsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.agents}>
        <FillLayout masterWidth="300px">
          <AgentsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.chat}>
        <FillLayout layout="chat">
          <ChatView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.tools}>
        <FillLayout masterWidth="300px">
          <ToolsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.integrations}>
        <PageLayout layout="integration">
          <IntegrationsView access={access} />
        </PageLayout>
      </Route>

      <Route path={routePatterns.approvals}>
        <PageLayout>
          <ApprovalsView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.userIntegrations}>
        <PageLayout>
          <UserIntegrationsView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.userIntegrationsAlias}>
        <Redirect to={userIntegrationsPath()} replace />
      </Route>

      <Route path={routePatterns.skills}>
        <PageLayout>
          <SkillsView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.communication}>
        <FillLayout layout="graph">
          <AgentGraphView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.communicationAlias}>
        <Redirect to={communicationPath()} replace />
      </Route>

      <Route path={routePatterns.workflowRuns}>
        <FillLayout layout="workflow-runs">
          <WorkflowsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.workflows}>
        <FillLayout layout="workflow-registry">
          <WorkflowsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.triggers}>
        <PageLayout>
          <TriggersView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.channels}>
        <PageLayout>
          <ChannelsView />
        </PageLayout>
      </Route>

      <Route path={routePatterns.evals}>
        <FillLayout>
          <EvalsView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.traces}>
        <FillLayout>
          <TracesView />
        </FillLayout>
      </Route>

      <Route path={routePatterns.providers}>
        <PageLayout>
          <ProvidersView />
        </PageLayout>
      </Route>

      <Route>
        <Redirect to={workspaceMode === null ? setupPath() : agentsPath()} replace />
      </Route>
    </Switch>
  );
}

function UserRoutes() {
  return (
    <Switch>
      <Route path={routePatterns.userIntegrations}>
        <PageLayout>
          <UserIntegrationsView />
        </PageLayout>
      </Route>

      <Route>
        <Redirect to={userIntegrationsPath()} replace />
      </Route>
    </Switch>
  );
}
