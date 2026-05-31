import { A2AChat, type A2AAgentSuggestion, type A2AChatPersistenceAdapter } from "@mokronos/a2a-chat-ui";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Command,
  FileJson,
  GitBranch,
  Globe,
  HelpCircle,
  KeyRound,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  Network,
  Pencil,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import type { FormEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import {
  addGoogleDiscoverySource,
  addGraphqlSource,
  addMcpSource,
  addOpenApiSource,
  addSkill,
  agentA2aUrl,
  addAgent,
  apiOrigin,
  apiUrl,
  deleteChatSession,
  detectSource,
  getEvalSession,
  getHealth,
  inspectAgentInternals,
  listChatSessions,
  listAgents,
  listEvalSessions,
  listExecutorSources,
  listSkills,
  listWorkflows,
  probeMcpEndpoint,
  probeGoogleDiscovery,
  pullSkills,
  previewOpenApiSpec,
  removeAgent,
  removeExecutorSource,
  removeSkill,
  setExecutorToolModes,
  startExecutorOAuth,
  updateAgent,
  updateMcpSource,
  workflowA2aUrl,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentGraphView } from "@/AgentGraphView";
import { TracesView } from "@/TracesView";
import { WorkflowEditorView } from "@/WorkflowEditorView";
import { SchemaExplorer } from "@/components/schema-explorer";
import { opinionatedEventRenderers } from "@/event-renderers";
import { cn } from "@/lib/utils";
import type {
  Agent,
  AgentInternalsResponse,
  CreateAgentInput,
  EvalSessionDetail,
  EvalSessionSummary,
  ExecutorSourcesResponse,
  SourceStaticAuthInput,
  Skill,
  ExecutorToolMode,
  Workflow,
} from "agentdock-sdk/api";

type Loadable<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

type View = "agents" | "create" | "chat" | "sources" | "skills" | "communication" | "workflows" | "evals" | "traces";
type ThemeMode = "light" | "dark";

type AppRoute =
  | { view: "agents" }
  | { view: "create" }
  | { view: "chat"; agentId: string | null }
  | { view: "sources"; agentId: string | null }
  | { view: "skills" }
  | { view: "communication" }
  | { view: "workflows" }
  | { view: "evals" }
  | { view: "traces" };

type ChatTarget =
  | { kind: "agent"; id: string; name: string; description: string; url: string; agent: Agent }
  | { kind: "workflow"; id: string; name: string; description: string; url: string; workflow: Workflow };

const agentTargetId = (agentId: string): string => `agent:${agentId}`;
const workflowTargetId = (workflowId: string): string => `workflow:${workflowId}`;
const HOME_INTERNAL_AGENT_ID = "agentdock-home";

type McpSourceForm = {
  readonly sourceUrl: string;
  readonly sourceKind: "mcp" | "openapi" | "graphql" | "googleDiscovery";
  readonly endpoint: string;
  readonly name: string;
  readonly namespace: string;
  readonly specUrl: string;
  readonly baseUrl: string;
  readonly introspectionJson: string;
  readonly googleDiscoveryUrl: string;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly authKind: McpAuthKind;
  readonly credentialValue: string;
  readonly headerName: string;
  readonly queryParamName: string;
};

type McpAuthKind = "none" | "oauth2" | "bearer" | "basic" | "apiKeyHeader" | "authToken" | "accessToken" | "customHeader" | "queryParam" | "cookie";
type McpEditAuthKind = "keep" | McpAuthKind;
type DetectedAuthMethod = "None" | "OAuth 2.0" | "Unknown";
type SourceAddMode = "detect" | "manual";
type SourceMessage = { readonly kind: "error" | "success" | "info"; readonly text: string };

type McpEditForm = {
  readonly sourceId: string;
  readonly name: string;
  readonly endpoint: string;
  readonly authKind: McpEditAuthKind;
  readonly credentialValue: string;
  readonly headerName: string;
  readonly queryParamName: string;
};

const createMcpSourceForm = (): McpSourceForm => ({
  sourceUrl: "",
  sourceKind: "mcp",
  endpoint: "",
  name: "",
  namespace: "",
  specUrl: "",
  baseUrl: "",
  introspectionJson: "",
  googleDiscoveryUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
  oauthClientId: "",
  oauthClientSecret: "",
  authKind: "none",
  credentialValue: "",
  headerName: "X-API-Key",
  queryParamName: "api_key",
});

const mcpAuthDescription = (authKind: McpAuthKind | McpEditAuthKind): string => {
  switch (authKind) {
    case "keep":
      return "Leave the current credential binding unchanged.";
    case "oauth2":
      return "Use the server OAuth flow and store a managed connection.";
    case "bearer":
      return "Sends Authorization: Bearer <token>.";
    case "basic":
      return "Sends Authorization: Basic <base64 credentials>.";
    case "apiKeyHeader":
      return "Sends the value in X-API-Key.";
    case "authToken":
      return "Sends the value in X-Auth-Token.";
    case "accessToken":
      return "Sends the value in X-Access-Token.";
    case "customHeader":
      return "Sends the value in a custom header.";
    case "queryParam":
      return "Appends the value as a query parameter.";
    case "cookie":
      return "Sends the value in the Cookie header.";
    case "none":
      return "Connect without credentials.";
  }
};

const buildMcpStaticAuth = (form: Pick<McpSourceForm, "authKind" | "credentialValue" | "headerName" | "queryParamName">): SourceStaticAuthInput => {
  const token = form.credentialValue.trim();
  if (form.authKind === "none" || form.authKind === "oauth2") return { kind: "none" as const };
  if (token.length === 0) throw new Error("Enter a credential value for the selected auth method.");

  switch (form.authKind) {
    case "bearer":
      return { kind: "header" as const, headerName: "Authorization", token, prefix: "Bearer " };
    case "basic":
      return { kind: "header" as const, headerName: "Authorization", token, prefix: "Basic " };
    case "apiKeyHeader":
      return { kind: "header" as const, headerName: "X-API-Key", token };
    case "authToken":
      return { kind: "header" as const, headerName: "X-Auth-Token", token };
    case "accessToken":
      return { kind: "header" as const, headerName: "X-Access-Token", token };
    case "customHeader": {
      const headerName = form.headerName.trim();
      if (headerName.length === 0) throw new Error("Enter a header name for custom header auth.");
      return { kind: "header" as const, headerName, token };
    }
    case "cookie":
      return { kind: "header" as const, headerName: "Cookie", token };
    case "queryParam": {
      const paramName = form.queryParamName.trim();
      if (paramName.length === 0) throw new Error("Enter a query parameter name for query auth.");
      return { kind: "queryParam" as const, paramName, token };
    }
  }
};

type OAuthPopupMessage = {
  readonly type: "agentdock:oauth-result";
  readonly ok: boolean;
  readonly payload: unknown;
};

const createDefaultForm = (): CreateAgentInput => ({
  name: "",
  description: "",
  instructions: "",
  model: "openai:gpt-5.4-mini",
  tools: [],
  skillIds: [],
  communication: {
    allowAll: false,
    allowedAgentIds: [],
  },
  version: "0.1.0",
  capabilities: {
    pushNotifications: false,
    streaming: true,
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
});

const parseList = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const formatList = (values: ReadonlyArray<string>): string => (values.length > 0 ? values.join(", ") : "—");

const formatJson = (value: unknown): string => {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatCommunication = (agent: Agent): string =>
  agent.communication.allowAll ? "All agents" : formatList(agent.communication.allowedAgentIds);

const agentToForm = (agent: Agent): CreateAgentInput => ({
  name: agent.name,
  description: agent.description,
  instructions: agent.instructions,
  model: agent.model,
  tools: agent.tools,
  skillIds: agent.skillIds,
  communication: agent.communication,
  version: agent.version,
  capabilities: agent.capabilities,
  defaultInputModes: agent.defaultInputModes,
  defaultOutputModes: agent.defaultOutputModes,
});

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const isOAuthPopupMessage = (value: unknown): value is OAuthPopupMessage =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "agentdock:oauth-result";

const safeDecodePathSegment = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseRoute = (pathname: string): AppRoute => {
  const parts = pathname.split("/").filter(Boolean);
  const [page, rawAgentId] = parts;

  if (!page) {
    return { view: "agents" };
  }

  if (page === "agents") {
    return { view: "agents" };
  }

  if (page === "new") {
    return { view: "create" };
  }

  if (page === "chat") {
    return { view: "chat", agentId: safeDecodePathSegment(rawAgentId) };
  }

  if (page === "sources") {
    return { view: "sources", agentId: safeDecodePathSegment(rawAgentId) };
  }

  if (page === "skills") {
    return { view: "skills" };
  }

  if (page === "graph" || page === "communication") {
    return { view: "communication" };
  }

  if (page === "workflows") {
    return { view: "workflows" };
  }

  if (page === "evals") {
    return { view: "evals" };
  }

  if (page === "traces") {
    return { view: "traces" };
  }

  return { view: "agents" };
};

const routeToPath = (route: AppRoute): string => {
  switch (route.view) {
    case "agents":
      return "/agents";
    case "create":
      return "/new";
    case "chat":
      return route.agentId ? `/chat/${encodeURIComponent(route.agentId)}` : "/chat";
    case "sources":
      return route.agentId ? `/sources/${encodeURIComponent(route.agentId)}` : "/sources";
    case "skills":
      return "/skills";
    case "communication":
      return "/communication";
    case "workflows":
      return "/workflows";
    case "evals":
      return "/evals";
    case "traces":
      return "/traces";
  }
};

const viewPath = (view: View, agentId?: string | null): string => {
  switch (view) {
    case "agents":
      return "/agents";
    case "create":
      return "/new";
    case "chat":
      return agentId ? `/chat/${encodeURIComponent(agentId)}` : "/chat";
    case "sources":
      return agentId ? `/sources/${encodeURIComponent(agentId)}` : "/sources";
    case "skills":
      return "/skills";
    case "communication":
      return "/communication";
    case "workflows":
      return "/workflows";
    case "evals":
      return "/evals";
    case "traces":
      return "/traces";
  }
};

const isModifiedClick = (event: ReactMouseEvent): boolean =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

const currentBrowserRoute = (): AppRoute => {
  if (typeof window === "undefined") {
    return { view: "agents" };
  }

  return parseRoute(window.location.pathname);
};

const waitForOAuthPopup = (authorizationUrl: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const popup = window.open(authorizationUrl, "agentdock-oauth", "popup,width=520,height=720");
    if (!popup) {
      reject(new Error("OAuth popup was blocked."));
      return;
    }

    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("OAuth popup timed out."));
    }, 15 * 60 * 1000);

    function onMessage(event: MessageEvent) {
      if (event.origin !== apiOrigin || !isOAuthPopupMessage(event.data)) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (event.data.ok) {
        resolve();
      } else {
        reject(new Error("OAuth authorization failed."));
      }
    }

    window.addEventListener("message", onMessage);
  });

const getInitialTheme = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = window.localStorage.getItem("agentdock-theme");
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const getInitialSidebarCollapsed = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const stored = window.localStorage.getItem("agentdock-sidebar-collapsed");
  if (stored === "true" || stored === "false") {
    return stored === "true";
  }

  return window.matchMedia("(max-width: 768px)").matches;
};

export function App() {
  const [route, setRoute] = useState<AppRoute>(currentBrowserRoute);
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: listAgents,
    refetchInterval: 15_000,
  });
  const workflowsQuery = useQuery({
    queryKey: ["workflows"],
    queryFn: listWorkflows,
    refetchInterval: 15_000,
  });
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: listSkills,
    refetchInterval: 15_000,
  });
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });

  const toLoadable = <T,>(
    status: "pending" | "error" | "success",
    data: T | undefined,
    error: unknown,
    errorFallback: string,
  ): Loadable<T> => {
    if (status === "pending") return { status: "loading" };
    if (status === "error") return { status: "error", message: toErrorMessage(error, errorFallback) };
    return { status: "ready", data: data as T };
  };

  const agentsState = toLoadable<ReadonlyArray<Agent>>(agentsQuery.status, agentsQuery.data, agentsQuery.error, "Could not load agents.");
  const workflowsState = toLoadable<ReadonlyArray<Workflow>>(workflowsQuery.status, workflowsQuery.data, workflowsQuery.error, "Could not load workflows.");
  const skillsState = toLoadable<ReadonlyArray<Skill>>(skillsQuery.status, skillsQuery.data, skillsQuery.error, "Could not load skills.");
  const healthState = toLoadable<string>(healthQuery.status, healthQuery.data, healthQuery.error, "Could not reach API.");
  const [form, setForm] = useState<CreateAgentInput>(createDefaultForm);
  const [createPending, setCreatePending] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [removePendingId, setRemovePendingId] = useState<string | null>(null);
  const [chatTargetId, setChatTargetId] = useState<string | null>(() => {
    const initialRoute = currentBrowserRoute();
    return initialRoute.view === "chat" ? initialRoute.agentId : null;
  });
  const [sourcesAgentId, setSourcesAgentId] = useState<string | null>(() => {
    const initialRoute = currentBrowserRoute();
    return initialRoute.view === "sources" ? initialRoute.agentId : null;
  });
  const sourcesAgentForQuery = sourcesAgentId;
  const sourcesQuery = useQuery({
    queryKey: ["executor-sources", sourcesAgentForQuery],
    queryFn: () => listExecutorSources(sourcesAgentForQuery as string),
    enabled: Boolean(sourcesAgentForQuery),
    refetchInterval: 15_000,
  });
  const sourcesState: Loadable<ExecutorSourcesResponse> = !sourcesAgentForQuery
    ? { status: "idle" }
    : sourcesQuery.status === "pending"
      ? { status: "loading" }
      : sourcesQuery.status === "error"
        ? { status: "error", message: toErrorMessage(sourcesQuery.error, "Could not load sources.") }
        : { status: "ready", data: sourcesQuery.data };
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(getInitialSidebarCollapsed);

  const navigate = useCallback((nextRoute: AppRoute) => {
    const nextPath = routeToPath(nextRoute);
    startTransition(() => setRoute(nextRoute));

    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
  }, []);

  const navigateView = useCallback(
    (nextView: View) => {
      if (nextView === "chat") {
        navigate({ view: "chat", agentId: chatTargetId });
        return;
      }

      if (nextView === "sources") {
        navigate({ view: "sources", agentId: sourcesAgentId });
        return;
      }

      navigate({ view: nextView });
    },
    [chatTargetId, navigate, sourcesAgentId],
  );

  useEffect(() => {
    const onPopState = () => {
      startTransition(() => setRoute(currentBrowserRoute()));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("agentdock-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("agentdock-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const loadData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
      queryClient.invalidateQueries({ queryKey: ["workflows"] }),
      queryClient.invalidateQueries({ queryKey: ["skills"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
    ]);
  }, [queryClient]);

  useEffect(() => {
    if (agentsQuery.data && agentsQuery.data[0]) {
      const firstId = agentTargetId(agentsQuery.data[0].id);
      setChatTargetId((current) => current ?? firstId);
    }
  }, [agentsQuery.data]);

  const agents = agentsState.status === "ready" ? agentsState.data : [];
  const workflows = workflowsState.status === "ready" ? workflowsState.data : [];
  const skills = skillsState.status === "ready" ? skillsState.data : [];
  const view = route.view;
  const chatTargets = useMemo<Array<ChatTarget>>(
    () => [
      ...agents.map((agent) => ({
        kind: "agent" as const,
        id: agentTargetId(agent.id),
        name: agent.name,
        description: agent.description,
        url: agentA2aUrl(agent.id),
        agent,
      })),
      ...workflows.map((workflow) => ({
        kind: "workflow" as const,
        id: workflowTargetId(workflow.id),
        name: workflow.name,
        description: workflow.description,
        url: workflowA2aUrl(workflow.id),
        workflow,
      })),
    ],
    [agents, workflows],
  );
  const chatTarget = chatTargets.find((target) => target.id === chatTargetId) ?? chatTargets[0] ?? null;
  const sourcesAgent = agents.find((agent) => agent.id === sourcesAgentId) ?? null;

  const chatSuggestions = useMemo<Array<A2AAgentSuggestion>>(
    () =>
      chatTargets.map((target) => ({
        label: `${target.name} (${target.kind})`,
        url: target.url,
        description: target.description,
      })),
    [chatTargets],
  );

  const handleCreateAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatePending(true);

    try {
      const savedAgent = editingAgentId ? await updateAgent(editingAgentId, form) : await addAgent(form);
      startTransition(() => {
        setForm(createDefaultForm());
        setEditingAgentId(null);
        setChatTargetId((current) => current ?? agentTargetId(savedAgent.id));
      });
      navigate({ view: "agents" });
      await loadData();
    } finally {
      setCreatePending(false);
    }
  };

  const handleEditAgent = (agent: Agent) => {
    startTransition(() => {
      setForm(agentToForm(agent));
      setEditingAgentId(agent.id);
    });
    navigate({ view: "create" });
  };

  const handleCancelForm = () => {
    startTransition(() => {
      setForm(createDefaultForm());
      setEditingAgentId(null);
    });
    navigate({ view: "agents" });
  };

  const handleRemoveAgent = async (agentId: string) => {
    setRemovePendingId(agentId);

    try {
      await removeAgent(agentId);
      startTransition(() => {
        setChatTargetId((current) => (current === agentTargetId(agentId) ? null : current));
      });
      await loadData();
    } finally {
      setRemovePendingId(null);
    }
  };

  const loadSources = useCallback(
    async (agentId: string) => {
      await queryClient.invalidateQueries({ queryKey: ["executor-sources", agentId] });
    },
    [queryClient],
  );

  useEffect(() => {
    if (route.view !== "create" && editingAgentId) {
      setForm(createDefaultForm());
      setEditingAgentId(null);
    }

    if (route.view === "chat") {
      setChatTargetId(route.agentId);
    }

    if (route.view === "sources") {
      setSourcesAgentId(route.agentId);
      if (route.agentId) {
        void loadSources(route.agentId);
      }
    }
  }, [editingAgentId, loadSources, route]);

  const handleManageSources = (agentId: string) => {
    setSourcesAgentId(agentId);
    navigate({ view: "sources", agentId });
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        view={view}
        chatAgentId={chatTargetId}
        sourcesAgentId={sourcesAgentId}
        onChange={navigateView}
        agentCount={agents.length}
        workflowCount={workflows.length}
        skillCount={skills.length}
        health={healthState}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <main className={cn("flex min-w-0 flex-1 flex-col", view === "communication" || view === "workflows" || view === "evals" ? "overflow-hidden" : "overflow-y-auto")}>
          <div
            className={cn(
              "w-full",
              view === "communication" || view === "workflows" || view === "evals"
                ? "flex h-full min-h-0 flex-col px-4 py-6 md:px-6 md:py-6"
                : "mx-auto max-w-6xl px-4 py-6 md:px-10 md:py-10",
            )}
          >
          {view === "agents" ? (
            <AgentsView
              agents={agents}
              isLoading={agentsState.status === "loading"}
              error={agentsState.status === "error" ? agentsState.message : null}
              onCreate={() => navigate({ view: "create" })}
              onChat={(agentId) => {
                const targetId = agentTargetId(agentId);
                setChatTargetId(targetId);
                navigate({ view: "chat", agentId: targetId });
              }}
              onSources={handleManageSources}
              onEdit={handleEditAgent}
              onRemove={handleRemoveAgent}
              removePendingId={removePendingId}
            />
          ) : null}

          {view === "create" ? (
            <CreateAgentView
              form={form}
              onChange={setForm}
              onSubmit={handleCreateAgent}
              onCancel={handleCancelForm}
              pending={createPending}
              mode={editingAgentId ? "edit" : "create"}
              skills={skills}
            />
          ) : null}

          {view === "skills" ? (
            <SkillsView
              skills={skills}
              isLoading={skillsState.status === "loading"}
              error={skillsState.status === "error" ? skillsState.message : null}
              onChanged={loadData}
            />
          ) : null}

          {view === "chat" ? (
            <ChatView
              agents={agents}
              workflows={workflows}
              chatTarget={chatTarget}
              chatSuggestions={chatSuggestions}
              onSelectAgent={(agentId) => {
                setChatTargetId(agentId);
                navigate({ view: "chat", agentId });
              }}
              onCreate={() => navigate({ view: "create" })}
            />
          ) : null}

          {view === "sources" ? (
            <SourcesView
              agents={agents}
              selectedAgent={sourcesAgent}
              sourcesState={sourcesState}
              onSelectAgent={(agentId) => {
                setSourcesAgentId(agentId);
                navigate({ view: "sources", agentId });
              }}
              onRefresh={() => sourcesAgentId && loadSources(sourcesAgentId)}
              onCreate={() => navigate({ view: "create" })}
            />
          ) : null}

          {view === "communication" ? <AgentGraphView agents={agents} onAgentsChanged={loadData} /> : null}

          {view === "workflows" ? <WorkflowEditorView workflows={workflows} agents={agents} onWorkflowsChanged={loadData} /> : null}

          {view === "evals" ? <EvalsView /> : null}

          {view === "traces" ? <TracesView /> : null}
          </div>
        </main>
        <HomeAgentPanel />
      </div>
    </div>
  );
}

function Sidebar({
  view,
  chatAgentId,
  sourcesAgentId,
  onChange,
  agentCount,
  workflowCount,
  skillCount,
  health,
  theme,
  onToggleTheme,
  collapsed,
  onToggleCollapsed,
}: {
  view: View;
  chatAgentId: string | null;
  sourcesAgentId: string | null;
  onChange: (view: View) => void;
  agentCount: number;
  workflowCount: number;
  skillCount: number;
  health: Loadable<string>;
  theme: ThemeMode;
  onToggleTheme: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden overscroll-contain border-r border-sidebar-border bg-sidebar py-5 transition-[width] duration-200",
        collapsed ? "w-16 items-center px-2" : "w-60 px-3",
      )}
    >
      <div className={cn("flex h-8 items-center", collapsed ? "justify-center" : "justify-between gap-2 pl-1")}>
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
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      </div>

      <nav className={cn("mt-8 flex flex-col gap-1", collapsed && "items-center")}>
        <NavItem
          collapsed={collapsed}
          icon={<Bot className="size-4" />}
          label="Agents"
          href={viewPath("agents")}
          active={view === "agents"}
          onClick={() => onChange("agents")}
          trailing={
            agentCount > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">{agentCount}</span>
            ) : null
          }
        />
        <NavItem
          collapsed={collapsed}
          icon={<Plug className="size-4" />}
          label="Sources"
          href={viewPath("sources", sourcesAgentId)}
          active={view === "sources"}
          onClick={() => onChange("sources")}
        />
        <NavItem
          collapsed={collapsed}
          icon={<Sparkles className="size-4" />}
          label="Skills"
          href={viewPath("skills")}
          active={view === "skills"}
          onClick={() => onChange("skills")}
          trailing={skillCount > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{skillCount}</span> : null}
        />
        <NavItem
          collapsed={collapsed}
          icon={<Network className="size-4" />}
          label="Communication"
          href={viewPath("communication")}
          active={view === "communication"}
          onClick={() => onChange("communication")}
        />
        <NavItem
          collapsed={collapsed}
          icon={<GitBranch className="size-4" />}
          label="Workflows"
          href={viewPath("workflows")}
          active={view === "workflows"}
          onClick={() => onChange("workflows")}
          trailing={workflowCount > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{workflowCount}</span> : null}
        />
        <NavItem
          collapsed={collapsed}
          icon={<ClipboardCheck className="size-4" />}
          label="Evals"
          href={viewPath("evals")}
          active={view === "evals"}
          onClick={() => onChange("evals")}
        />
        <NavItem
          collapsed={collapsed}
          icon={<Activity className="size-4" />}
          label="Traces"
          href={viewPath("traces")}
          active={view === "traces"}
          onClick={() => onChange("traces")}
        />
        <NavItem
          collapsed={collapsed}
          icon={<MessageSquare className="size-4" />}
          label="Chat"
          href={viewPath("chat", chatAgentId)}
          active={view === "chat"}
          onClick={() => onChange("chat")}
        />
      </nav>

      <div className={cn("mt-auto flex flex-col gap-1 border-t border-sidebar-border pt-3", collapsed && "items-center")}>
        <HealthIndicator collapsed={collapsed} health={health} />
        <SidebarButton
          collapsed={collapsed}
          icon={theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          label={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={onToggleTheme}
        />
      </div>
    </aside>
  );
}

function NavItem({
  collapsed,
  icon,
  label,
  href,
  active,
  onClick,
  trailing,
}: {
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  href: string;
  active: boolean;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (isModifiedClick(event)) return;
        event.preventDefault();
        onClick();
      }}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center rounded-md text-sm transition-colors",
        collapsed ? "size-10 justify-center" : "h-9 justify-between px-2",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
      )}
    >
      <span className={cn("flex items-center", !collapsed && "gap-2")}>
        <span className={cn("text-muted-foreground", active && "text-sidebar-accent-foreground")}>{icon}</span>
        {collapsed ? null : <span className="font-medium">{label}</span>}
      </span>
      {!collapsed && trailing}
    </a>
  );
}

function SidebarButton({
  collapsed,
  icon,
  label,
  onClick,
}: {
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center rounded-md text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
        collapsed ? "size-10 justify-center" : "h-9 gap-2 px-2",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      {collapsed ? null : <span>{label}</span>}
    </button>
  );
}

function HealthIndicator({ collapsed, health }: { collapsed: boolean; health: Loadable<string> }) {
  const isHealthy = health.status === "ready" && health.data === "OK";
  const isLoading = health.status === "loading";
  const dotClass = cn(
    "inline-flex size-2 rounded-full",
    isHealthy
      ? "bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_25%,transparent)]"
      : isLoading
        ? "animate-pulse bg-muted-foreground/50"
        : "bg-destructive",
  );
  const labelText = isHealthy
    ? "API healthy"
    : isLoading
      ? "Checking API…"
      : health.status === "error"
        ? "API offline"
        : "API unknown";

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

function AgentsView({
  agents,
  isLoading,
  error,
  onCreate,
  onChat,
  onSources,
  onEdit,
  onRemove,
  removePendingId,
}: {
  agents: ReadonlyArray<Agent>;
  isLoading: boolean;
  error: string | null;
  onCreate: () => void;
  onChat: (agentId: string) => void;
  onSources: (agentId: string) => void;
  onEdit: (agent: Agent) => void;
  onRemove: (agentId: string) => void;
  removePendingId: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agents yet"
        description="Create your first agent to get started. It will be reachable through the A2A route immediately."
        action={
          <Button onClick={onCreate}>
            <Plus className="size-4" />
            Create your first agent
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">{agents.length} registered</p>
        </div>
        <Button onClick={onCreate} asChild>
          <a
            href={viewPath("create")}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              onCreate();
            }}
          >
            <Plus className="size-4" />
            New agent
          </a>
        </Button>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            isRemoving={removePendingId === agent.id}
            chatHref={viewPath("chat", agentTargetId(agent.id))}
            sourcesHref={viewPath("sources", agent.id)}
            onChat={() => onChat(agent.id)}
            onSources={() => onSources(agent.id)}
            onEdit={() => onEdit(agent)}
            onRemove={() => onRemove(agent.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  isRemoving,
  chatHref,
  sourcesHref,
  onChat,
  onSources,
  onEdit,
  onRemove,
}: {
  agent: Agent;
  isRemoving: boolean;
  chatHref: string;
  sourcesHref: string;
  onChat: () => void;
  onSources: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const internalsQuery = useQuery({
    queryKey: ["agent-internals", agent.id],
    queryFn: () => inspectAgentInternals(agent.id),
    enabled: expanded,
  });

  return (
    <div className="group flex flex-col rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-primary/30 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.18)]">
      <div className="flex items-start gap-3 min-w-0">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Bot className="size-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="truncate text-base font-semibold">{agent.name}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary" className="font-mono">
              {agent.model}
            </Badge>
            <Badge variant="outline">v{agent.version}</Badge>
          </div>
        </div>
      </div>

      <p className="mt-4 line-clamp-3 text-sm text-muted-foreground">{agent.description}</p>

      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="mt-3 inline-flex items-center gap-1 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-3 rounded-lg bg-muted/40 p-3 text-xs">
          <DetailLine label="ID" value={agent.id} mono />
          <DetailLine label="A2A route" value={agentA2aUrl(agent.id)} mono />
          <DetailLine label="Tools" value={formatList(agent.tools)} />
          <DetailLine label="Can message" value={formatCommunication(agent)} />
          <DetailLine label="Inputs" value={formatList(agent.defaultInputModes)} />
          <DetailLine label="Outputs" value={formatList(agent.defaultOutputModes)} />
          <DetailLine
            label="Capabilities"
            value={`streaming · ${agent.capabilities.streaming ? "on" : "off"}, push · ${agent.capabilities.pushNotifications ? "on" : "off"}`}
          />
          {agent.instructions ? (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Instructions
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
                {agent.instructions}
              </p>
            </div>
          ) : null}
          <AgentInternalsPanel state={internalsQuery} />
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-2 border-t border-border/60 pt-4">
        <Button size="sm" className="flex-1" asChild>
          <a
            href={chatHref}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              onChat();
            }}
          >
            <MessageSquare className="size-4" />
            Chat
          </a>
        </Button>
        <Button size="icon-sm" variant="secondary" asChild title="Manage sources">
          <a
            href={sourcesHref}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              onSources();
            }}
          >
            <Plug className="size-4" />
          </a>
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={onEdit} title="Edit agent">
          <Pencil className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRemove}
          disabled={isRemoving}
          title="Remove agent"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AgentInternalsPanel({ state }: { state: UseQueryResult<AgentInternalsResponse> }) {
  if (state.isLoading) {
    return <div className="text-xs text-muted-foreground">Loading internals...</div>;
  }

  if (state.isError) {
    return <div className="text-xs text-destructive">Failed to load internals: {toErrorMessage(state.error, "Unknown error")}</div>;
  }

  if (!state.data) return null;

  const internalTools = state.data.tools.filter((tool) => tool.source === "internal");
  const executorTools = state.data.tools.filter((tool) => tool.source === "executor");
  const { tokenCount } = state.data.prompt;
  const { contextWindow, maxOutputTokens, provider, id: modelId } = state.data.model;
  const pct = contextWindow ? Math.min(100, (tokenCount / contextWindow) * 100) : null;
  const pctLabel = pct !== null ? `${pct < 1 && pct > 0 ? "<1" : pct.toFixed(pct < 10 ? 1 : 0)}%` : null;
  const barTone = pct === null ? "bg-primary/60" : pct < 60 ? "bg-emerald-500" : pct < 85 ? "bg-amber-500" : "bg-destructive";

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
            <span className="font-mono text-sm font-semibold">{tokenCount.toLocaleString()}</span>
            {contextWindow ? (
              <span className="text-[11px] text-muted-foreground">
                {" / "}
                {contextWindow.toLocaleString()} tokens
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground"> tokens</span>
            )}
          </div>
          {pctLabel ? <div className="font-mono text-[11px] text-muted-foreground">{pctLabel}</div> : null}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", barTone)} style={{ width: `${pct ?? 0}%` }} />
        </div>
        {maxOutputTokens ? (
          <div className="mt-2 text-[10px] text-muted-foreground">
            Max output {maxOutputTokens.toLocaleString()} tokens
          </div>
        ) : null}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <ToolList title="Internal tools" icon={<Wrench className="size-3" />} tools={internalTools} />
        <ToolList title="Executor tools" icon={<Plug className="size-3" />} tools={executorTools} />
      </div>

      <PromptBlock title="Estimated final system prompt" value={state.data.prompt.finalInstructions || "—"} />
    </div>
  );
}

const TOOL_MODE_STYLES: Record<string, string> = {
  native: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  discoverable: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  disabled: "border-muted bg-muted/40 text-muted-foreground",
};

function ToolList({
  title,
  icon,
  tools,
}: {
  title: string;
  icon: ReactNode;
  tools: ReadonlyArray<AgentInternalsResponse["tools"][number]>;
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
              const label = tool.mode ?? (tool.active ? "active" : "inactive");
              const dim = tool.mode === "disabled" || (!tool.mode && !tool.active);
              return (
                <li
                  key={`${tool.source}:${tool.id}`}
                  className={cn(
                    "rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border/60 hover:bg-muted/40",
                    dim && "opacity-60",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="break-all font-mono text-[11px] font-medium text-foreground">{tool.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider",
                        TOOL_MODE_STYLES[label] ?? TOOL_MODE_STYLES.disabled,
                      )}
                    >
                      {label}
                    </span>
                  </div>
                  {tool.description ? (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {tool.description}
                    </div>
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
    <div className="flex items-start gap-2">
      <div className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("min-w-0 break-words text-foreground/90", mono && "font-mono")}>{value}</div>
    </div>
  );
}

type SourceKind = "mcp" | "openapi" | "graphql" | "googleDiscovery";

const SOURCE_KIND_META: Record<SourceKind, { label: string; Icon: typeof Plug; tint: string; bg: string }> = {
  mcp: { label: "MCP", Icon: Plug, tint: "text-violet-500", bg: "bg-violet-500/10" },
  openapi: { label: "OpenAPI", Icon: FileJson, tint: "text-emerald-500", bg: "bg-emerald-500/10" },
  graphql: { label: "GraphQL", Icon: Network, tint: "text-pink-500", bg: "bg-pink-500/10" },
  googleDiscovery: { label: "Google Discovery", Icon: Globe, tint: "text-sky-500", bg: "bg-sky-500/10" },
};

const AUTH_METHOD_META: Record<DetectedAuthMethod, { Icon: typeof KeyRound; tint: string; bg: string; description: string }> = {
  None: { Icon: ShieldCheck, tint: "text-emerald-500", bg: "bg-emerald-500/10", description: "No credentials required" },
  "OAuth 2.0": { Icon: KeyRound, tint: "text-amber-500", bg: "bg-amber-500/10", description: "Sign in with OAuth 2.0" },
  Unknown: { Icon: HelpCircle, tint: "text-muted-foreground", bg: "bg-muted", description: "Auth method could not be determined" },
};

const CONFIDENCE_CLASS: Record<string, string> = {
  high: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const SOURCE_MESSAGE_CLASS: Record<SourceMessage["kind"], string> = {
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  info: "border-border bg-muted text-muted-foreground",
};

function SourceDetectionPanel({
  results,
  sourceKind,
  displayName,
  authMethod,
}: {
  results: ReadonlyArray<{ kind: string; confidence: string; name: string }>;
  sourceKind: SourceKind;
  displayName: string;
  authMethod: DetectedAuthMethod | null;
}) {
  const best = results[0];
  if (!best) return null;
  const kindMeta = SOURCE_KIND_META[sourceKind];
  const authMeta = authMethod ? AUTH_METHOD_META[authMethod] : null;
  const confidenceClass = CONFIDENCE_CLASS[best.confidence] ?? "border-border bg-muted text-muted-foreground";
  const KindIcon = kindMeta.Icon;
  const AuthIcon = authMeta?.Icon;
  const alternatives = results.slice(1);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card to-muted/30">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", kindMeta.bg)}>
          <KindIcon className={cn("size-5", kindMeta.tint)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" />
            Detected
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold">{displayName || best.name}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">{kindMeta.label}</Badge>
            <Badge variant="outline" className={cn("capitalize", confidenceClass)}>{best.confidence} confidence</Badge>
          </div>
        </div>
      </div>
      {authMeta && AuthIcon ? (
        <div className="flex items-center gap-3 border-t border-border bg-background/40 px-4 py-2.5">
          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", authMeta.bg)}>
            <AuthIcon className={cn("size-4", authMeta.tint)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold">{authMethod}</div>
            <div className="text-[11px] text-muted-foreground">{authMeta.description}</div>
          </div>
        </div>
      ) : null}
      {alternatives.length > 0 ? (
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">Other matches: </span>
          {alternatives.map((r, i) => (
            <span key={`${r.kind}-${r.name}-${i}`}>
              {i > 0 ? " · " : ""}
              {r.name} <span className="opacity-70">({r.kind}, {r.confidence})</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex h-48 flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-lg bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-1/2 rounded bg-muted" />
          <div className="h-3 w-1/3 rounded bg-muted" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-3 rounded bg-muted" />
        <div className="h-3 w-4/5 rounded bg-muted" />
      </div>
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Bot className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function StatusMessage({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  return (
    <div className={cn(
      "rounded-lg border px-4 py-3 text-sm",
      kind === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/50 text-foreground",
    )}>
      {children}
    </div>
  );
}

function HomeAgentPanel() {
  const [minimized, setMinimized] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const chatPersistence = useMemo<A2AChatPersistenceAdapter>(
    () => ({
      loadSessions: () => listChatSessions(HOME_INTERNAL_AGENT_ID).then((sessions) => [...sessions]),
      deleteSession: ({ sessionId }) => deleteChatSession(HOME_INTERNAL_AGENT_ID, sessionId),
    }),
    [],
  );

  const homeAgentUrl = agentA2aUrl(HOME_INTERNAL_AGENT_ID);
  const suggestions = useMemo<Array<A2AAgentSuggestion>>(
    () => [
      {
        label: "Agentdock Assistant",
        url: homeAgentUrl,
        description: "Internal assistant for this Agentdock instance.",
      },
    ],
    [homeAgentUrl],
  );

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-card-foreground shadow-lg transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label="Restore assistant panel"
      >
        <MessageSquare className="size-4" />
        Assistant
      </button>
    );
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 min-w-0 w-full shrink-0 border-t border-border bg-card/60 p-3",
        maximized
          ? "absolute inset-0 z-30 h-full border-t-0 bg-card lg:border lg:border-border"
          : "h-[34rem] lg:fixed lg:bottom-4 lg:right-4 lg:z-20 lg:w-[27rem] lg:max-w-[27rem] lg:border lg:border-border lg:bg-card/80 lg:shadow-2xl lg:backdrop-blur",
      )}
    >
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="absolute right-6 top-6 z-10 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMaximized((current) => !current)}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label={maximized ? "Restore assistant panel" : "Maximize assistant panel"}
            title={maximized ? "Restore assistant" : "Maximize assistant"}
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setMaximized(false);
              setMinimized(true);
            }}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Minimize assistant panel"
            title="Minimize assistant"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
        <A2AChat
          key={HOME_INTERNAL_AGENT_ID}
          layout="panel"
          className="h-full min-w-0 rounded-xl border-0 py-0 shadow-none ring-0"
          title="Agentdock Assistant"
          description="Internal assistant for this Agentdock instance."
          initialUrl={homeAgentUrl}
          autoConnect
          showConnectionForm={false}
          proxyBasePath={false}
          agentSuggestions={suggestions}
          eventRenderers={[...opinionatedEventRenderers]}
          persistence={chatPersistence}
        />
      </div>
    </aside>
  );
}

function CreateAgentView({
  form,
  onChange,
  onSubmit,
  onCancel,
  pending,
  mode,
  skills,
}: {
  form: CreateAgentInput;
  onChange: (next: CreateAgentInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  pending: boolean;
  mode: "create" | "edit";
  skills: ReadonlyArray<Skill>;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (partial: Partial<CreateAgentInput>) => onChange({ ...form, ...partial });

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-8">
      <FormSection
        title="Identity"
        description="A clear name and description help you and other clients pick the right agent."
      >
        <Field label="Name" htmlFor="agent-name">
          <Input
            id="agent-name"
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="e.g. Research Assistant"
            required
          />
        </Field>

        <Field label="Description" htmlFor="agent-description">
          <Textarea
            id="agent-description"
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="What this agent does, in one or two sentences."
            className="min-h-20"
            required
          />
        </Field>
      </FormSection>

      <FormSection
        title="Behavior"
        description="Choose the model and write the agent's system instructions."
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Model" htmlFor="agent-model">
            <Input
              id="agent-model"
              value={form.model}
              onChange={(event) => update({ model: event.target.value })}
              placeholder="provider:model"
              required
            />
          </Field>
          <Field label="Version" htmlFor="agent-version">
            <Input
              id="agent-version"
              value={form.version}
              onChange={(event) => update({ version: event.target.value })}
              required
            />
          </Field>
        </div>

        <Field label="Instructions" htmlFor="agent-instructions">
          <Textarea
            id="agent-instructions"
            value={form.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            placeholder="System prompt: tone, scope, do's and don'ts."
            className="min-h-36 font-mono text-sm"
            required
          />
        </Field>
        <Field label="Skills" htmlFor="agent-skills" description="Assigned skills are discoverable by this agent and loadable with the load_skill tool.">
          <div className="grid gap-2 rounded-lg border border-border p-3">
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No global skills installed yet.</p>
            ) : skills.map((skill) => (
              <label key={skill.id} className="flex items-start gap-3 rounded-md p-2 hover:bg-muted/60">
                <input
                  id="agent-skills"
                  type="checkbox"
                  className="mt-1"
                  checked={form.skillIds.includes(skill.id)}
                  onChange={(event) => update({
                    skillIds: event.target.checked
                      ? [...form.skillIds, skill.id]
                      : form.skillIds.filter((id) => id !== skill.id),
                  })}
                />
                <span>
                  <span className="block text-sm font-medium">{skill.name}</span>
                  <span className="block text-xs text-muted-foreground">{skill.description}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
      </FormSection>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((current) => !current)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn("size-4 transition-transform", showAdvanced && "rotate-180")} />
          Advanced settings
        </button>

        {showAdvanced ? (
          <div className="mt-4 space-y-6 rounded-xl border border-border bg-muted/30 p-5">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Tools" htmlFor="agent-tools" description="Comma-separated tool names.">
                <Input
                  id="agent-tools"
                  value={form.tools.join(", ")}
                  onChange={(event) => update({ tools: [...parseList(event.target.value)] })}
                />
              </Field>
              <Field label="Input modes" htmlFor="agent-input-modes" description="Comma-separated MIME types.">
                <Input
                  id="agent-input-modes"
                  value={form.defaultInputModes.join(", ")}
                  onChange={(event) => update({ defaultInputModes: [...parseList(event.target.value)] })}
                />
              </Field>
              <Field label="Output modes" htmlFor="agent-output-modes" description="Comma-separated MIME types.">
                <Input
                  id="agent-output-modes"
                  value={form.defaultOutputModes.join(", ")}
                  onChange={(event) => update({ defaultOutputModes: [...parseList(event.target.value)] })}
                />
              </Field>
              <Field
                label="Allowed agent IDs"
                htmlFor="agent-communication-targets"
                description="Comma-separated IDs this agent can message. Ignored when all agents are allowed."
              >
                <Input
                  id="agent-communication-targets"
                  value={form.communication.allowedAgentIds.join(", ")}
                  disabled={form.communication.allowAll}
                  onChange={(event) =>
                    update({
                      communication: {
                        ...form.communication,
                        allowedAgentIds: [...parseList(event.target.value)],
                      },
                    })
                  }
                />
              </Field>
            </div>

            <Toggle
              label="Can message all agents"
              description="Expose every other registered agent to this agent's communication tool."
              checked={form.communication.allowAll}
              onChange={(checked) => update({ communication: { ...form.communication, allowAll: checked } })}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle
                label="Streaming"
                description="Stream partial responses to the client."
                checked={form.capabilities.streaming}
                onChange={(checked) =>
                  update({ capabilities: { ...form.capabilities, streaming: checked } })
                }
              />
              <Toggle
                label="Push notifications"
                description="Allow the agent to send out-of-band updates."
                checked={form.capabilities.pushNotifications}
                onChange={(checked) =>
                  update({ capabilities: { ...form.capabilities, pushNotifications: checked } })
                }
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border/60 pt-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? (mode === "edit" ? "Saving…" : "Creating…") : mode === "edit" ? "Save agent" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-5 md:grid-cols-[220px_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-3 transition-colors",
        checked && "border-primary/40 bg-primary/5",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 accent-[var(--primary)]"
      />
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
    </label>
  );
}

function SkillsView({
  skills,
  isLoading,
  error,
  onChanged,
}: {
  skills: ReadonlyArray<Skill>;
  isLoading: boolean;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [content, setContent] = useState("---\nname: my-skill\ndescription: What this skill does and when to use it.\n---\n\n# My Skill\n\nInstructions for the agent.");
  const [source, setSource] = useState("vercel-labs/agent-skills");
  const [skillFilter, setSkillFilter] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<SourceMessage | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillContent, setSelectedSkillContent] = useState("");
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;
  const selectedSkillEditable = selectedSkill?.source === "manual";

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) {
      setSelectedSkillId(null);
      setSelectedSkillContent("");
    }
  }, [selectedSkill, selectedSkillId]);

  const saveManual = async () => {
    setPending("manual");
    setMessage(null);
    try {
      await addSkill({ content, source: "manual" });
      setMessage({ kind: "success", text: "Skill saved." });
      await onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to save skill.") });
    } finally {
      setPending(null);
    }
  };

  const pull = async () => {
    setPending("pull");
    setMessage(null);
    try {
      const skills = skillFilter.trim().length > 0 ? parseList(skillFilter) : [];
      const result = await pullSkills({ source, skills: [...skills] });
      setMessage({ kind: "success", text: `Imported ${result.skills.length} skill${result.skills.length === 1 ? "" : "s"}.` });
      await onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to pull skills.") });
    } finally {
      setPending(null);
    }
  };

  const deleteSkill = async (skillId: string) => {
    setPending(`delete:${skillId}`);
    setMessage(null);
    try {
      await removeSkill(skillId);
      setMessage({ kind: "success", text: "Skill deleted." });
      await onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to delete skill.") });
    } finally {
      setPending(null);
    }
  };

  const selectSkill = (skill: Skill) => {
    setSelectedSkillId(skill.id);
    setSelectedSkillContent(skill.content);
  };

  const saveSelectedSkill = async () => {
    if (!selectedSkill || !selectedSkillEditable) return;
    setPending(`edit:${selectedSkill.id}`);
    setMessage(null);
    try {
      await addSkill({ content: selectedSkillContent, source: "manual" });
      setMessage({ kind: "success", text: "Skill updated." });
      await onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to update skill.") });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeader title="Skills" description="Install and manage global Agent Skills." />
      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <FormSection title="Pull Skills" description="Runs the Vercel skills CLI globally for Agentdock, then imports SKILL.md files.">
          <Field label="Source" htmlFor="skill-source" description="GitHub shorthand, git URL, or local path supported by npx skills add.">
            <Input id="skill-source" value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <Field label="Skill names" htmlFor="skill-filter" description="Comma-separated. Leave empty to import all skills from the source.">
            <Input id="skill-filter" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} placeholder="frontend-design, skill-creator" />
          </Field>
          <Button type="button" onClick={pull} disabled={pending !== null || source.trim().length === 0}>Pull Skills</Button>
        </FormSection>

        <FormSection title="Add Skill" description="Paste a standards-compliant SKILL.md with YAML frontmatter.">
          <Textarea value={content} onChange={(event) => setContent(event.target.value)} className="min-h-56 font-mono text-sm" />
          <Button type="button" onClick={saveManual} disabled={pending !== null}>Save Skill</Button>
        </FormSection>
      </div>

      <FormSection title="Installed Skills" description="Assign skills from each agent's create/edit view.">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading skills...</p> : null}
        <div className="grid gap-4">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => selectSkill(skill)}>
                  <h3 className="font-semibold">{skill.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
                </button>
                <div className="flex items-center gap-2">
                  {skill.source ? <Badge variant="secondary">{skill.source}</Badge> : null}
                  <Button type="button" variant="secondary" onClick={() => selectSkill(skill)} disabled={pending !== null}>
                    {skill.source === "manual" ? "Edit" : "View"}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() => void deleteSkill(skill.id)}
                    title="Delete skill"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {skills.length === 0 && !isLoading ? <EmptyState title="No skills installed" description="Pull a skill source or paste a SKILL.md to get started." /> : null}
        </div>
      </FormSection>

      {selectedSkill ? (
        <FormSection
          title={selectedSkillEditable ? "Edit Skill" : "View Skill"}
          description={selectedSkillEditable ? "Manual skills can be edited in place." : "Pulled skills are read-only here. Delete and pull again to update them."}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold">{selectedSkill.name}</div>
                <div className="text-xs text-muted-foreground">{selectedSkill.source ?? "manual"}</div>
              </div>
              <Button type="button" variant="ghost" onClick={() => setSelectedSkillId(null)}>
                Close
              </Button>
            </div>
            <Textarea
              value={selectedSkillEditable ? selectedSkillContent : selectedSkill.content}
              readOnly={!selectedSkillEditable}
              onChange={(event) => setSelectedSkillContent(event.target.value)}
              className="min-h-[480px] font-mono text-sm"
            />
            {selectedSkillEditable ? (
              <div className="flex justify-end">
                <Button type="button" onClick={saveSelectedSkill} disabled={pending !== null}>
                  Save changes
                </Button>
              </div>
            ) : null}
          </div>
        </FormSection>
      ) : null}
    </div>
  );
}

const TOOL_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: ExecutorToolMode;
  readonly label: string;
  readonly title: string;
  readonly icon: ReactNode;
}> = [
  { mode: "native", label: "Native", title: "Native: include in execute description", icon: <Zap className="size-3.5" /> },
  { mode: "discoverable", label: "Discoverable", title: "Discoverable: available through tool discovery", icon: <Search className="size-3.5" /> },
  { mode: "disabled", label: "Disabled", title: "Disabled: hidden and blocked", icon: <XCircle className="size-3.5" /> },
];

function ToolModeSwitch({
  mode,
  disabled,
  onChange,
}: {
  mode: ExecutorToolMode;
  disabled: boolean;
  onChange: (mode: ExecutorToolMode) => void;
}) {
  const [optimisticMode, setOptimisticMode] = useState<ExecutorToolMode | null>(null);
  const displayMode = optimisticMode ?? mode;
  // Reset optimistic state when the server-confirmed mode matches it.
  useEffect(() => {
    if (optimisticMode !== null && optimisticMode === mode) setOptimisticMode(null);
  }, [mode, optimisticMode]);

  const selectedIndex = Math.max(0, TOOL_MODE_OPTIONS.findIndex((o) => o.mode === displayMode));
  const count = TOOL_MODE_OPTIONS.length;

  return (
    <div
      className="relative inline-flex items-center rounded-full border border-border bg-muted/40 p-0.5"
      aria-label="Tool mode"
      role="radiogroup"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 rounded-full bg-background shadow-sm transition-transform duration-200 ease-out"
        style={{
          width: `calc((100% - 0.25rem) / ${count})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {TOOL_MODE_OPTIONS.map((option) => {
        const active = option.mode === displayMode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            aria-label={option.title}
            disabled={disabled && optimisticMode === null}
            onClick={() => {
              if (option.mode === displayMode) return;
              setOptimisticMode(option.mode);
              onChange(option.mode);
            }}
            className={cn(
              "relative z-10 flex size-7 items-center justify-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SourcesView({
  agents,
  selectedAgent,
  sourcesState,
  onSelectAgent,
  onRefresh,
  onCreate,
}: {
  agents: ReadonlyArray<Agent>;
  selectedAgent: Agent | null;
  sourcesState: Loadable<ExecutorSourcesResponse>;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
}) {
  const [form, setForm] = useState<McpSourceForm>(createMcpSourceForm);
  const [editForm, setEditForm] = useState<McpEditForm | null>(null);
  const [pending, setPending] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [sourceAddMode, setSourceAddMode] = useState<SourceAddMode>("detect");
  const [detectedResults, setDetectedResults] = useState<ReadonlyArray<{ kind: string; confidence: string; name: string }> | null>(null);
  const [detectedAuthMethod, setDetectedAuthMethod] = useState<DetectedAuthMethod | null>(null);
  const [sourcePendingId, setSourcePendingId] = useState<string | null>(null);
  const [modePendingToolId, setModePendingToolId] = useState<string | null>(null);
  const [message, setMessage] = useState<SourceMessage | null>(null);
  const manualEntry = sourceAddMode === "manual";

  const addSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAgent) return;
    setPending(true);
    setMessage(null);

    try {
      let activeForm = form;
      if (!manualEntry && (!detectedResults || detectedResults.length === 0)) {
        const url = form.sourceUrl.trim();
        if (!url) throw new Error("Enter a source URL.");
        const detected = await detectSource(selectedAgent.id, { url });
        const best = detected.results[0];
        if (!best) throw new Error("Could not detect a source type from this URL.");
        const sourceKind = best.kind === "openapi" ? "openapi" : best.kind === "graphql" ? "graphql" : best.kind === "googleDiscovery" ? "googleDiscovery" : "mcp";
        const authMethod = sourceKind === "googleDiscovery" ? "OAuth 2.0" : "None";
        activeForm = {
          ...form,
          sourceUrl: best.endpoint,
          sourceKind,
          endpoint: sourceKind === "mcp" || sourceKind === "graphql" ? best.endpoint : form.endpoint,
          specUrl: sourceKind === "openapi" ? best.endpoint : form.specUrl,
          googleDiscoveryUrl: sourceKind === "googleDiscovery" ? best.endpoint : form.googleDiscoveryUrl,
          name: best.name,
          namespace: best.namespace,
          authKind: sourceKind === "googleDiscovery" ? "oauth2" : "none",
        };
        setForm(activeForm);
        setDetectedResults(detected.results.map((result) => ({ kind: result.kind, confidence: result.confidence, name: result.name })));
        setDetectedAuthMethod(authMethod);
      }

      if (activeForm.sourceKind === "openapi") {
        const specUrl = activeForm.specUrl.trim() || activeForm.sourceUrl.trim();
        const name = activeForm.name.trim() || "OpenAPI";
        const namespace = activeForm.namespace.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "openapi";
        const preview = await previewOpenApiSpec(selectedAgent.id, { spec: { kind: "url", url: specUrl } });
        const firstServer = typeof preview === "object" && preview !== null && "servers" in preview && Array.isArray((preview as { servers?: unknown }).servers)
          ? ((preview as { servers: Array<{ url?: unknown }> }).servers[0]?.url ?? "")
          : "";
        const added = await addOpenApiSource(selectedAgent.id, {
          spec: { kind: "url", url: specUrl },
          name,
          namespace,
          baseUrl: String(firstServer || ""),
          auth: { kind: "none" },
        });
        setForm(createMcpSourceForm());
        setSourceAddMode("detect");
        setDetectedResults(null);
        setDetectedAuthMethod(null);
        setMessage({ kind: "success", text: `Added ${added.namespace} with ${added.toolCount} tools.` });
        onRefresh();
        return;
      }

      if (activeForm.sourceKind === "graphql") {
        const name = activeForm.name.trim() || "GraphQL";
        const namespace = activeForm.namespace.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "graphql";
        const added = await addGraphqlSource(selectedAgent.id, {
          endpoint: activeForm.endpoint || activeForm.sourceUrl,
          name,
          namespace,
          auth: { kind: "none" },
        });
        setForm(createMcpSourceForm());
        setSourceAddMode("detect");
        setDetectedResults(null);
        setDetectedAuthMethod(null);
        setMessage({ kind: "success", text: `Added ${added.namespace} with ${added.toolCount} tools.` });
        onRefresh();
        return;
      }

      if (activeForm.sourceKind === "googleDiscovery") {
        const discoveryUrl = activeForm.googleDiscoveryUrl.trim() || activeForm.sourceUrl.trim();
        const probe = await probeGoogleDiscovery(selectedAgent.id, { discoveryUrl });
        const probeName = typeof probe === "object" && probe !== null && "name" in probe && typeof (probe as { name?: unknown }).name === "string" ? (probe as { name: string }).name : "Google Discovery";
        const probeScopes = typeof probe === "object" && probe !== null && "scopes" in probe && Array.isArray((probe as { scopes?: unknown }).scopes) ? (probe as { scopes: string[] }).scopes : [];
        const name = activeForm.name.trim() || probeName;
        const namespace = activeForm.namespace.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "google_discovery";
        const added = await addGoogleDiscoverySource(selectedAgent.id, {
          discoveryUrl,
          name,
          namespace,
          auth: activeForm.oauthClientId.trim()
            ? { kind: "oauth2", oauth2: { clientId: activeForm.oauthClientId.trim(), clientSecret: activeForm.oauthClientSecret.trim() || undefined, scopes: probeScopes } }
            : { kind: "none" },
        });
        if (added.authorizationUrl) {
          await waitForOAuthPopup(added.authorizationUrl);
        }
        setForm(createMcpSourceForm());
        setSourceAddMode("detect");
        setDetectedResults(null);
        setDetectedAuthMethod(null);
        setMessage({ kind: "success", text: `Added ${added.namespace} with ${added.toolCount} tools.` });
        onRefresh();
        return;
      }

      const endpoint = activeForm.endpoint.trim() || activeForm.sourceUrl.trim();
      const probe = await probeMcpEndpoint(selectedAgent.id, { endpoint });
      const namespace = probe.namespace;
      const name = probe.name;
      let connectionId: string | undefined;

      if (probe.requiresOAuth) {
        if (!probe.supportsDynamicRegistration) {
          throw new Error(
            "This MCP server requires OAuth, but its authorization server does not support dynamic client registration. Select a static header, query parameter, or cookie auth method instead.",
          );
        }
        const redirectUrl = apiUrl(`/oauth/callback?agentId=${selectedAgent.id}&webOrigin=${encodeURIComponent(window.location.origin)}`);
        const started = await startExecutorOAuth(selectedAgent.id, {
          endpoint,
          name,
          namespace,
          redirectUrl,
        });
        connectionId = started.connectionId;
        if (started.authorizationUrl) {
          await waitForOAuthPopup(started.authorizationUrl);
        }
      }

      const auth = connectionId ? { kind: "oauth2" as const, connectionId } : { kind: "none" as const };

      const added = await addMcpSource(selectedAgent.id, {
        name,
        endpoint,
        namespace,
        auth,
      });
      setForm(createMcpSourceForm());
      setSourceAddMode("detect");
      setDetectedResults(null);
      setDetectedAuthMethod(null);
      setMessage({ kind: "success", text: `Added ${added.namespace} with ${added.toolCount} tools.` });
      onRefresh();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to add source.") });
    } finally {
      setPending(false);
    }
  };

  const detectSourceType = async () => {
    if (!selectedAgent) return;
    const url = form.sourceUrl.trim() || form.endpoint.trim() || form.specUrl.trim() || form.googleDiscoveryUrl.trim();
    if (!url) {
      setMessage({ kind: "error", text: "Enter a URL to detect." });
      return;
    }
    setDetecting(true);
    setMessage(null);
    try {
      const detected = await detectSource(selectedAgent.id, { url });
      setDetectedResults(detected.results.map((result) => ({ kind: result.kind, confidence: result.confidence, name: result.name })));
      const best = detected.results[0];
      if (!best) {
        setMessage({ kind: "error", text: "Could not detect a source type. Use Manual entry if you know what this URL is." });
        return;
      }
      const sourceKind = best.kind === "openapi" ? "openapi" : best.kind === "graphql" ? "graphql" : best.kind === "googleDiscovery" ? "googleDiscovery" : "mcp";
      let authMethod: DetectedAuthMethod = sourceKind === "googleDiscovery" ? "OAuth 2.0" : "None";
      if (sourceKind === "mcp") {
        try {
          const probe = await probeMcpEndpoint(selectedAgent.id, { endpoint: best.endpoint });
          authMethod = probe.requiresOAuth ? "OAuth 2.0" : "None";
        } catch {
          authMethod = "Unknown";
        }
      }
      setForm({
        ...form,
        sourceUrl: best.endpoint,
        sourceKind,
        endpoint: sourceKind === "mcp" || sourceKind === "graphql" ? best.endpoint : form.endpoint,
        specUrl: sourceKind === "openapi" ? best.endpoint : form.specUrl,
        googleDiscoveryUrl: sourceKind === "googleDiscovery" ? best.endpoint : form.googleDiscoveryUrl,
        name: best.name,
        namespace: best.namespace,
        authKind: sourceKind === "googleDiscovery" ? "oauth2" : "none",
      });
      setDetectedAuthMethod(authMethod);
      setMessage(null);
      if (sourceKind === "openapi") {
        const preview = await previewOpenApiSpec(selectedAgent.id, { spec: { kind: "url", url: best.endpoint } });
        const headerPresets = typeof preview === "object" && preview !== null && "headerPresets" in preview && Array.isArray((preview as { headerPresets?: unknown }).headerPresets)
          ? (preview as { headerPresets: Array<{ label?: unknown; secretHeaders?: unknown }> }).headerPresets
          : [];
        const firstPreset = headerPresets[0];
        if (firstPreset?.label && Array.isArray(firstPreset.secretHeaders)) {
          const firstHeader = firstPreset.secretHeaders[0];
          if (typeof firstHeader === "string") {
            setForm((current) => ({
              ...current,
              authKind: firstHeader.toLowerCase() === "authorization" && String(firstPreset.label).toLowerCase().includes("bearer") ? "bearer" : "customHeader",
              headerName: firstHeader,
            }));
          }
        }
      }
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to detect source type.") });
    } finally {
      setDetecting(false);
    }
  };

  const enableManualEntry = () => {
    const url = form.sourceUrl.trim() || form.endpoint.trim() || form.specUrl.trim() || form.googleDiscoveryUrl.trim();
    setSourceAddMode("manual");
    setDetectedResults(null);
    setDetectedAuthMethod(null);
    setMessage(null);
    setForm({
      ...form,
      sourceUrl: url,
      endpoint: form.endpoint || (form.sourceKind === "mcp" || form.sourceKind === "graphql" ? url : ""),
      specUrl: form.specUrl || (form.sourceKind === "openapi" ? url : ""),
      googleDiscoveryUrl: form.googleDiscoveryUrl || (form.sourceKind === "googleDiscovery" ? url : ""),
    });
  };

  const updateManualSourceKind = (sourceKind: SourceKind) => {
    const url = form.sourceUrl.trim() || form.endpoint.trim() || form.specUrl.trim() || form.googleDiscoveryUrl.trim();
    setSourceAddMode("manual");
    setDetectedAuthMethod(sourceKind === "googleDiscovery" ? "OAuth 2.0" : null);
    setForm({
      ...form,
      sourceKind,
      sourceUrl: url,
      endpoint: sourceKind === "mcp" || sourceKind === "graphql" ? url : form.endpoint,
      specUrl: sourceKind === "openapi" ? url : form.specUrl,
      googleDiscoveryUrl: sourceKind === "googleDiscovery" ? url : form.googleDiscoveryUrl,
      authKind: sourceKind === "googleDiscovery" ? "oauth2" : form.authKind,
    });
  };

  const saveSourceEdit = async (source: ExecutorSourcesResponse["sources"][number]) => {
    if (!selectedAgent || !editForm || editForm.sourceId !== source.id) return;
    setSourcePendingId(source.id);
    setMessage(null);

    try {
      const auth = editForm.authKind === "keep" ? undefined : buildMcpStaticAuth({
        authKind: editForm.authKind,
        credentialValue: editForm.credentialValue,
        headerName: editForm.headerName,
        queryParamName: editForm.queryParamName,
      });
      await updateMcpSource(selectedAgent.id, source.id, {
        name: editForm.name.trim() || source.name,
        endpoint: editForm.endpoint.trim() || source.url || "",
        ...(auth ? { auth } : {}),
      });
      setEditForm(null);
      setMessage({ kind: "success", text: `Updated ${source.id}.` });
      onRefresh();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to update source.") });
    } finally {
      setSourcePendingId(null);
    }
  };

  const deleteSource = async (sourceId: string) => {
    if (!selectedAgent || !window.confirm(`Remove MCP source "${sourceId}"?`)) return;
    setSourcePendingId(sourceId);
    setMessage(null);

    try {
      await removeExecutorSource(selectedAgent.id, sourceId);
      if (editForm?.sourceId === sourceId) setEditForm(null);
      setMessage({ kind: "success", text: `Removed ${sourceId}.` });
      onRefresh();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to remove source.") });
    } finally {
      setSourcePendingId(null);
    }
  };

  const updateToolMode = async (tool: ExecutorSourcesResponse["tools"][number], mode: ExecutorToolMode) => {
    if (!selectedAgent || sourcesState.status !== "ready") return;
    setModePendingToolId(tool.id);
    setMessage(null);

    try {
      await setExecutorToolModes(selectedAgent.id, { modes: [{ toolId: tool.id, mode }] });
      onRefresh();
    } catch (error) {
      setMessage({ kind: "error", text: toErrorMessage(error, "Failed to update tool mode.") });
    } finally {
      setModePendingToolId(null);
    }
  };

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agents for sources"
        description="Create an agent first, then attach MCP sources to that agent's Executor."
        action={
          <Button onClick={onCreate}>
            <Plus className="size-4" />
            Create an agent
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Executor sources</h1>
          <p className="text-sm text-muted-foreground">Add remote MCP servers separately for each agent.</p>
        </div>
        <Select value={selectedAgent?.id ?? ""} onValueChange={onSelectAgent}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue placeholder="Select agent" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedAgent ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            {sourcesState.status === "loading" ? (
              <SkeletonCard />
            ) : sourcesState.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {sourcesState.message}
              </div>
            ) : sourcesState.status === "ready" && sourcesState.data.sources.length > 0 ? (
              sourcesState.data.sources.map((source) => (
                <div key={source.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold">{source.name}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{source.id}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{source.toolCount} tools</Badge>
                      {source.canEdit ? (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="secondary"
                          disabled={sourcePendingId === source.id}
                          onClick={() =>
                            setEditForm({
                              sourceId: source.id,
                              name: source.name,
                              endpoint: source.url ?? "",
                              authKind: "keep",
                              credentialValue: "",
                              headerName: "X-API-Key",
                              queryParamName: "api_key",
                            })
                          }
                          title="Edit source"
                        >
                          <Pencil className="size-4" />
                        </Button>
                      ) : null}
                      {source.canRemove ? (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          disabled={sourcePendingId === source.id}
                          onClick={() => deleteSource(source.id)}
                          title="Remove source"
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {source.url ? <div className="mt-3 break-all text-sm text-muted-foreground">{source.url}</div> : null}
                  {editForm?.sourceId === source.id ? (
                    <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="Name" htmlFor={`edit-source-name-${source.id}`}>
                          <Input
                            id={`edit-source-name-${source.id}`}
                            value={editForm.name}
                            onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                          />
                        </Field>
                        <Field label="Endpoint" htmlFor={`edit-source-endpoint-${source.id}`}>
                          <Input
                            id={`edit-source-endpoint-${source.id}`}
                            value={editForm.endpoint}
                            onChange={(event) => setEditForm({ ...editForm, endpoint: event.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="Auth method" htmlFor={`edit-source-auth-${source.id}`} description={mcpAuthDescription(editForm.authKind)}>
                          <Select value={editForm.authKind} onValueChange={(value) => setEditForm({ ...editForm, authKind: value as McpEditAuthKind })}>
                            <SelectTrigger id={`edit-source-auth-${source.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="keep">Keep existing</SelectItem>
                              <SelectItem value="none">No auth</SelectItem>
                              <SelectItem value="bearer">Bearer token</SelectItem>
                              <SelectItem value="basic">Basic auth</SelectItem>
                              <SelectItem value="apiKeyHeader">API key header</SelectItem>
                              <SelectItem value="authToken">X-Auth-Token</SelectItem>
                              <SelectItem value="accessToken">X-Access-Token</SelectItem>
                              <SelectItem value="customHeader">Custom header</SelectItem>
                              <SelectItem value="queryParam">Query parameter</SelectItem>
                              <SelectItem value="cookie">Cookie</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        {editForm.authKind === "customHeader" ? (
                          <Field label="Header name" htmlFor={`edit-source-header-${source.id}`}>
                            <Input id={`edit-source-header-${source.id}`} value={editForm.headerName} onChange={(event) => setEditForm({ ...editForm, headerName: event.target.value })} placeholder="X-API-Key" />
                          </Field>
                        ) : null}
                        {editForm.authKind === "queryParam" ? (
                          <Field label="Query parameter" htmlFor={`edit-source-query-${source.id}`}>
                            <Input id={`edit-source-query-${source.id}`} value={editForm.queryParamName} onChange={(event) => setEditForm({ ...editForm, queryParamName: event.target.value })} placeholder="api_key" />
                          </Field>
                        ) : null}
                        {editForm.authKind !== "keep" && editForm.authKind !== "none" && editForm.authKind !== "oauth2" ? (
                          <Field label="Credential value" htmlFor={`edit-source-token-${source.id}`}>
                            <Input id={`edit-source-token-${source.id}`} type="password" value={editForm.credentialValue} onChange={(event) => setEditForm({ ...editForm, credentialValue: event.target.value })} placeholder="Secret value" />
                          </Field>
                        ) : null}
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={() => setEditForm(null)} disabled={sourcePendingId === source.id}>
                          Cancel
                        </Button>
                        <Button type="button" onClick={() => saveSourceEdit(source)} disabled={sourcePendingId === source.id}>
                          {sourcePendingId === source.id ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <details className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      Inspect tools/endpoints
                    </summary>
                    <div className="mt-3 space-y-3">
                      {sourcesState.data.tools.filter((tool) => tool.sourceId === source.id).map((tool) => (
                        <div key={tool.id} className="rounded-md border border-border bg-background p-3">
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                            <div className="min-w-0">
                              <div className="font-mono text-xs font-semibold">{tool.name}</div>
                              {tool.description ? <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p> : null}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              <ToolModeSwitch
                                mode={tool.mode}
                                disabled={modePendingToolId === tool.id}
                                onChange={(mode) => updateToolMode(tool, mode)}
                              />
                              <Badge variant="outline">{tool.pluginId}</Badge>
                            </div>
                          </div>
                          <div className="mt-3 grid gap-3 xl:grid-cols-2">
                            <SchemaExplorer schema={tool.inputSchema} title="Input schema" />
                            <SchemaExplorer schema={tool.outputSchema} title="Output schema" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              ))
            ) : (
              <EmptyState title="No MCP sources" description="Add Context7, Linear, or another remote MCP server." />
            )}
          </div>

          <form onSubmit={addSource} className="space-y-4 rounded-xl border border-border bg-card p-5">
            <div>
              <h2 className="font-semibold">Add source</h2>
              <p className="mt-1 text-xs text-muted-foreground">Detect a source from a URL, or enter the source details manually.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
              <Button
                type="button"
                variant={sourceAddMode === "detect" ? "default" : "ghost"}
                onClick={() => {
                  setSourceAddMode("detect");
                  setMessage(null);
                }}
              >
                Detect URL
              </Button>
              <Button type="button" variant={sourceAddMode === "manual" ? "default" : "ghost"} onClick={enableManualEntry}>
                Manual entry
              </Button>
            </div>
            {message ? (
              <div className={cn("min-w-0 overflow-hidden break-words rounded-md border px-3 py-2 text-xs font-medium", SOURCE_MESSAGE_CLASS[message.kind])}>
                {message.text}
              </div>
            ) : null}
            {sourceAddMode === "detect" ? (
              <Field label="Source URL" htmlFor="source-url" description="Detection checks registered plugins and selects the best match.">
                <div className="flex gap-2">
                  <Input id="source-url" value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} placeholder="https://api.example.com/openapi.json" />
                  <Button type="button" variant="secondary" onClick={detectSourceType} disabled={detecting || !selectedAgent}>
                    {detecting ? "Detecting..." : "Detect"}
                  </Button>
                </div>
              </Field>
            ) : null}
            {sourceAddMode === "detect" && detectedResults && detectedResults.length > 0 ? (
              <SourceDetectionPanel
                results={detectedResults}
                sourceKind={form.sourceKind}
                displayName={form.name}
                authMethod={detectedAuthMethod}
              />
            ) : null}
            {sourceAddMode === "manual" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Source type" htmlFor="source-kind" description="Detection will be skipped when you add the source.">
                  <Select value={form.sourceKind} onValueChange={(value) => updateManualSourceKind(value as SourceKind)}>
                    <SelectTrigger id="source-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mcp">MCP</SelectItem>
                      <SelectItem value="openapi">OpenAPI</SelectItem>
                      <SelectItem value="graphql">GraphQL</SelectItem>
                      <SelectItem value="googleDiscovery">Google Discovery</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Name" htmlFor="source-name" description="Optional display name. A namespace is derived if left blank.">
                  <Input id="source-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={SOURCE_KIND_META[form.sourceKind].label} />
                </Field>
                <Field label="Namespace" htmlFor="source-namespace" description="Optional stable id for generated tools.">
                  <Input id="source-namespace" value={form.namespace} onChange={(event) => setForm({ ...form, namespace: event.target.value })} placeholder={form.sourceKind} />
                </Field>
                {form.sourceKind === "openapi" ? (
                  <Field label="OpenAPI spec URL" htmlFor="source-spec-url" description="The JSON or YAML OpenAPI document to import.">
                    <Input id="source-spec-url" value={form.specUrl} onChange={(event) => setForm({ ...form, specUrl: event.target.value })} placeholder="https://api.example.com/openapi.json" />
                  </Field>
                ) : null}
                {form.sourceKind === "graphql" ? (
                  <Field label="GraphQL endpoint" htmlFor="source-graphql-endpoint" description="The endpoint used for introspection and queries.">
                    <Input id="source-graphql-endpoint" value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder="https://api.example.com/graphql" />
                  </Field>
                ) : null}
                {form.sourceKind === "mcp" ? (
                  <Field label="MCP endpoint" htmlFor="source-mcp-endpoint" description="The remote MCP server endpoint.">
                    <Input id="source-mcp-endpoint" value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder="https://mcp.example.com/mcp" />
                  </Field>
                ) : null}
                {form.sourceKind === "googleDiscovery" ? (
                  <Field label="Discovery URL" htmlFor="source-google-discovery-url" description="The Google Discovery REST document.">
                    <Input id="source-google-discovery-url" value={form.googleDiscoveryUrl} onChange={(event) => setForm({ ...form, googleDiscoveryUrl: event.target.value })} placeholder="https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest" />
                  </Field>
                ) : null}
              </div>
            ) : null}
            <Button type="submit" disabled={pending || !selectedAgent} className="w-full">
              <Plug className="size-4" />
              {pending ? "Adding…" : "Add source"}
            </Button>
          </form>
        </div>
      ) : (
        <EmptyState title="Select an agent" description="Choose an agent above to manage its Executor sources." />
      )}
    </div>
  );
}

const formatTimestamp = (value: number): string => new Date(value).toLocaleString();

const compactText = (value: string, maxLength = 180): string => {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

const actionLabel = (action: EvalSessionDetail["outcome"]["actions"][number]): string =>
  action.toolName ? `${action.type}: ${action.toolName}` : action.type;

function EvalsView() {
  const [sessionsState, setSessionsState] = useState<Loadable<ReadonlyArray<EvalSessionSummary>>>({ status: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<Loadable<EvalSessionDetail>>({ status: "idle" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [targetKind, setTargetKind] = useState<"all" | EvalSessionSummary["target"]["kind"]>("all");

  const loadSessions = useCallback(async () => {
    setSessionsState({ status: "loading" });
    try {
      const response = await listEvalSessions();
      startTransition(() => {
        setSessionsState({ status: "ready", data: response.sessions });
        setSelectedKey((current) => current ?? (response.sessions[0] ? `${response.sessions[0].target.id}\u0000${response.sessions[0].id}` : null));
      });
    } catch (error) {
      startTransition(() => setSessionsState({ status: "error", message: toErrorMessage(error, "Could not load eval sessions.") }));
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const sessions = sessionsState.status === "ready" ? sessionsState.data : [];
  const filteredSessions = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      if (targetKind !== "all" && session.target.kind !== targetKind) {
        return false;
      }

      if (!search) {
        return true;
      }

      return [session.title, session.target.name, session.initialMessage, session.outcome.text]
        .join("\n")
        .toLowerCase()
        .includes(search);
    });
  }, [deferredQuery, sessions, targetKind]);

  const selectedSession = filteredSessions.find((session) => `${session.target.id}\u0000${session.id}` === selectedKey) ?? filteredSessions[0] ?? null;

  useEffect(() => {
    if (!selectedSession) {
      setDetailState({ status: "idle" });
      return;
    }

    const key = `${selectedSession.target.id}\u0000${selectedSession.id}`;
    if (selectedKey !== key) {
      setSelectedKey(key);
    }

    setDetailState({ status: "loading" });
    void getEvalSession(selectedSession.target.id, selectedSession.id)
      .then((detail) => startTransition(() => setDetailState({ status: "ready", data: detail })))
      .catch((error) => startTransition(() => setDetailState({ status: "error", message: toErrorMessage(error, "Could not load session details.") })));
  }, [selectedKey, selectedSession]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Inspect saved agent and workflow sessions before we add labels and corrected-response editing.</p>
        </div>
        <Button variant="secondary" onClick={loadSessions} disabled={sessionsState.status === "loading"}>
          {sessionsState.status === "loading" ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          <div className="space-y-3 border-b border-border p-4">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, outcome, or target" />
            <Select value={targetKind} onValueChange={(value) => setTargetKind(value as typeof targetKind)}>
              <SelectTrigger>
                <SelectValue placeholder="Filter target" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All targets</SelectItem>
                <SelectItem value="agent">Agents</SelectItem>
                <SelectItem value="workflow">Workflows</SelectItem>
                <SelectItem value="unknown">Unknown</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {sessionsState.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{sessionsState.message}</div>
            ) : sessionsState.status === "loading" ? (
              <div className="space-y-2 p-2"><SkeletonCard /><SkeletonCard /></div>
            ) : filteredSessions.length === 0 ? (
              <EmptyState title="No sessions found" description="Run a chat with an agent or workflow, then come back here." />
            ) : (
              <div className="space-y-2">
                {filteredSessions.map((session) => {
                  const key = `${session.target.id}\u0000${session.id}`;
                  const active = selectedSession?.id === session.id && selectedSession.target.id === session.target.id;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      className={cn(
                        "w-full rounded-lg border p-3 text-left transition",
                        active ? "border-primary/60 bg-primary/5" : "border-border bg-background hover:border-primary/30",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{session.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant={session.target.kind === "workflow" ? "outline" : "secondary"}>{session.target.kind}</Badge>
                            <span className="truncate">{session.target.name}</span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[11px] text-muted-foreground">{formatTimestamp(session.updatedAt)}</div>
                      </div>
                      <p className="mt-3 text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Task:</span> {compactText(session.initialMessage || "No initial message")}</p>
                      <p className="mt-2 text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Outcome:</span> {compactText(session.outcome.text || "No final response")}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="outline">{session.messageCount} messages</Badge>
                        <Badge variant="outline">{session.actionCount} actions</Badge>
                        {session.outcome.state ? <Badge variant="outline">{session.outcome.state}</Badge> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0 overflow-y-auto rounded-xl border border-border bg-card p-5">
          {detailState.status === "loading" ? (
            <div className="space-y-4"><SkeletonCard /><SkeletonCard /></div>
          ) : detailState.status === "error" ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{detailState.message}</div>
          ) : detailState.status === "ready" ? (
            <EvalSessionDetailView session={detailState.data} />
          ) : (
            <EmptyState title="Select a session" description="Choose a saved session to inspect messages, tool calls, and outcome." />
          )}
        </section>
      </div>
    </div>
  );
}

function EvalSessionDetailView({ session }: { session: EvalSessionDetail }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={session.target.kind === "workflow" ? "outline" : "secondary"}>{session.target.kind}</Badge>
            <span className="text-sm text-muted-foreground">{session.target.name}</span>
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{session.title}</h2>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{session.target.id} / {session.id}</p>
        </div>
        <div className="text-xs text-muted-foreground lg:text-right">
          <div>Created {formatTimestamp(session.createdAt)}</div>
          <div>Updated {formatTimestamp(session.updatedAt)}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Initial task</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{session.initialMessage || "No initial message captured."}</p>
        </div>
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outcome</div>
            {session.outcome.state ? <Badge variant="outline">{session.outcome.state}</Badge> : null}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{session.outcome.text || "No final response captured."}</p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">Actions taken</h3>
          <Badge variant="outline">{session.outcome.actions.length}</Badge>
        </div>
        {session.outcome.actions.length > 0 ? (
          <div className="space-y-3">
            {session.outcome.actions.map((action) => (
              <div key={action.id} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={action.type === "tool-error" ? "destructive" : "secondary"}>{action.type}</Badge>
                  <span className="font-mono text-xs font-semibold">{actionLabel(action)}</span>
                </div>
                {action.toolCallId ? <div className="mt-1 font-mono text-[11px] text-muted-foreground">{action.toolCallId}</div> : null}
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {"input" in action ? <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{formatJson(action.input)}</pre> : null}
                  {"output" in action ? <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{formatJson(action.output)}</pre> : null}
                  {action.error ? <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{action.error}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tool calls or tool results captured for this session.</p>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">Message timeline</h3>
          <Badge variant="outline">{session.messages.length}</Badge>
        </div>
        <div className="space-y-3">
          {session.messages.map((message) => (
            <div key={message.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={message.role === "user" ? "secondary" : "outline"}>{message.role}</Badge>
                  <span className="font-mono text-[11px] text-muted-foreground">{message.id}</span>
                </div>
                {message.createdAt ? <span className="text-[11px] text-muted-foreground">{formatTimestamp(message.createdAt)}</span> : null}
              </div>
              {message.text ? <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p> : null}
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw parts</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-2 text-[11px]">{formatJson(message.parts)}</pre>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatView({
  agents,
  workflows,
  chatTarget,
  chatSuggestions,
  onSelectAgent,
  onCreate,
}: {
  agents: ReadonlyArray<Agent>;
  workflows: ReadonlyArray<Workflow>;
  chatTarget: ChatTarget | null;
  chatSuggestions: Array<A2AAgentSuggestion>;
  onSelectAgent: (agentId: string) => void;
  onCreate: () => void;
}) {
  const chatPersistence = useMemo<A2AChatPersistenceAdapter | null>(() => {
    if (!chatTarget || chatTarget.kind !== "agent") {
      return null;
    }

    return {
      loadSessions: () => listChatSessions(chatTarget.agent.id).then((sessions) => [...sessions]),
      deleteSession: ({ sessionId }) => deleteChatSession(chatTarget.agent.id, sessionId),
    };
  }, [chatTarget]);

  const hasTargets = agents.length + workflows.length > 0;

  return (
    <div className="space-y-4">
      {hasTargets ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Select value={chatTarget?.id ?? ""} onValueChange={onSelectAgent}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select agent or workflow" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agentTargetId(agent.id)}>
                  <span className="inline-flex items-center gap-2"><Badge variant="secondary">agent</Badge>{agent.name}</span>
                </SelectItem>
              ))}
              {workflows.map((workflow) => (
                <SelectItem key={workflow.id} value={workflowTargetId(workflow.id)}>
                  <span className="inline-flex items-center gap-2"><Badge variant="outline">workflow</Badge>{workflow.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chatTarget ? (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {chatTarget.url}
            </span>
          ) : null}
        </div>
      ) : null}

      {chatTarget ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <A2AChat
            key={chatTarget.id}
            title={chatTarget.name}
            description={chatTarget.description}
            initialUrl={chatTarget.url}
            autoConnect
            showConnectionForm={false}
            proxyBasePath={false}
            agentSuggestions={chatSuggestions}
            eventRenderers={[...opinionatedEventRenderers]}
            {...(chatPersistence ? { persistence: chatPersistence } : {})}
          />
        </div>
      ) : (
        <EmptyState
          title="No agent to chat with"
          description={
            !hasTargets
              ? "Create an agent or workflow first to start a conversation."
              : "Select an agent or workflow above to start chatting."
          }
          action={
            !hasTargets ? (
              <Button onClick={onCreate}>
                <Plus className="size-4" />
                Create an agent
              </Button>
            ) : null
          }
        />
      )}
    </div>
  );
}

export default App;
