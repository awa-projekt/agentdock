import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { updateAgent } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Agent, CreateAgentInput } from "agentdock-sdk/api";

type AgentNodeData = Record<string, unknown> & {
  readonly agent: Agent;
  readonly outgoingCount: number;
  readonly incomingCount: number;
  readonly allowAll: boolean;
};

type AgentNode = Node<AgentNodeData, "agent">;
type GraphPosition = { readonly x: number; readonly y: number };

const GRAPH_POSITIONS_STORAGE_KEY = "agentdock-agent-graph-positions";

const edgeOptions = {
  type: "smoothstep",
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed },
} satisfies Partial<Edge>;

const createEdgeId = (source: string, target: string): string => `${source}->${target}`;

const readStoredPositions = (): Record<string, GraphPosition> => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(GRAPH_POSITIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed as Record<string, GraphPosition>;
  } catch {
    return {};
  }
};

const writeStoredPositions = (nodes: ReadonlyArray<AgentNode>): void => {
  if (typeof window === "undefined") {
    return;
  }

  const positions = Object.fromEntries(nodes.map((node) => [node.id, node.position]));
  window.localStorage.setItem(GRAPH_POSITIONS_STORAGE_KEY, JSON.stringify(positions));
};

const createInitialNodes = (
  agents: ReadonlyArray<Agent>,
  previousNodes: ReadonlyArray<AgentNode>,
  edges: ReadonlyArray<Edge>,
  storedPositions: Record<string, GraphPosition>,
): Array<AgentNode> => {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const total = Math.max(agents.length, 1);
  const radius = Math.max(180, Math.min(420, total * 52));
  const centerX = 360;
  const centerY = 260;

  return agents.map((agent, index) => {
    const previous = previousById.get(agent.id);
    const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
    const outgoingCount = edges.filter((edge) => edge.source === agent.id).length;
    const incomingCount = edges.filter((edge) => edge.target === agent.id).length;

    return {
      id: agent.id,
      type: "agent",
      position: previous?.position ?? storedPositions[agent.id] ?? {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      },
      data: {
        agent,
        outgoingCount,
        incomingCount,
        allowAll: agent.communication.allowAll,
      },
    };
  });
};

const createCommunicationEdges = (agents: ReadonlyArray<Agent>): Array<Edge> => {
  const agentIds = new Set<string>(agents.map((agent) => agent.id));
  const edges = new Map<string, Edge>();

  for (const agent of agents) {
    const targetIds = agent.communication.allowAll
      ? agents.map((target) => target.id).filter((targetId) => targetId !== agent.id)
      : agent.communication.allowedAgentIds.filter((targetId) => targetId !== agent.id && agentIds.has(targetId));

    for (const targetId of targetIds) {
      const id = createEdgeId(agent.id, targetId);
      edges.set(id, {
        id,
        source: agent.id,
        target: targetId,
        ...edgeOptions,
      });
    }
  }

  return Array.from(edges.values());
};

const agentToInput = (agent: Agent, communication: Agent["communication"]): CreateAgentInput => ({
  name: agent.name,
  description: agent.description,
  instructions: agent.instructions,
  model: agent.model,
  tools: agent.tools,
  skillIds: agent.skillIds,
  communication,
  version: agent.version,
  capabilities: agent.capabilities,
  defaultInputModes: agent.defaultInputModes,
  defaultOutputModes: agent.defaultOutputModes,
});

const normalizeEdges = (edges: ReadonlyArray<Edge>, agents: ReadonlyArray<Agent>): Array<Edge> => {
  const agentIds = new Set<string>(agents.map((agent) => agent.id));
  const normalized = new Map<string, Edge>();

  for (const edge of edges) {
    if (!agentIds.has(edge.source) || !agentIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }

    const id = createEdgeId(edge.source, edge.target);
    normalized.set(id, {
      id,
      source: edge.source,
      target: edge.target,
      ...edgeOptions,
    });
  }

  return Array.from(normalized.values());
};

function AgentNodeCard({ data, selected }: NodeProps<AgentNode>) {
  return (
    <div
      className={cn(
        "relative w-64 rounded-xl border bg-card p-4 text-card-foreground shadow-lg transition-colors",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-4 !border-2 !border-background !bg-primary"
        title="Drop a connection here"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!size-4 !border-2 !border-background !bg-primary"
        title="Drag to another agent"
      />

      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Bot className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data.agent.name}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{data.agent.id}</div>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{data.agent.description}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant={data.allowAll ? "default" : "secondary"}>{data.allowAll ? "all targets" : `${data.outgoingCount} out`}</Badge>
        <Badge variant="outline">{data.incomingCount} in</Badge>
      </div>
    </div>
  );
}

const nodeTypes = {
  agent: AgentNodeCard,
} satisfies NodeTypes;

export function AgentGraphView({
  agents,
  onAgentsChanged,
}: {
  agents: ReadonlyArray<Agent>;
  onAgentsChanged: () => Promise<void>;
}) {
  const initialEdges = useMemo(() => createCommunicationEdges(agents), [agents]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(
    createInitialNodes(agents, [], initialEdges, readStoredPositions()),
  );
  const [error, setError] = useState<string | null>(null);
  const reconnectSuccessful = useRef(true);
  const reconnectingEdgeId = useRef<string | null>(null);

  useEffect(() => {
    const nextEdges = createCommunicationEdges(agents);
    setEdges(nextEdges);
    setNodes((currentNodes) => createInitialNodes(agents, currentNodes, nextEdges, readStoredPositions()));
  }, [agents, setEdges, setNodes]);

  useEffect(() => {
    setNodes((currentNodes) => createInitialNodes(agents, currentNodes, edges, readStoredPositions()));
  }, [agents, edges, setNodes]);

  const persistEdges = useCallback(
    async (nextEdges: ReadonlyArray<Edge>) => {
      const normalizedEdges = normalizeEdges(nextEdges, agents);
      const orderedAgentIds = agents.map((agent) => agent.id);
      const targetsBySource = new Map<string, Set<string>>();

      for (const edge of normalizedEdges) {
        const targets = targetsBySource.get(edge.source) ?? new Set<string>();
        targets.add(edge.target);
        targetsBySource.set(edge.source, targets);
      }

      setError(null);
      setEdges(normalizedEdges);

      try {
        await Promise.all(
          agents.map((agent) => {
            const targetIds = orderedAgentIds.filter((agentId) => targetsBySource.get(agent.id)?.has(agentId));
            const allOtherIds = orderedAgentIds.filter((agentId) => agentId !== agent.id);
            const allowAll = allOtherIds.length > 0 && targetIds.length === allOtherIds.length;
            const allowedAgentIds = allowAll ? [] : targetIds;

            if (
              agent.communication.allowAll === allowAll &&
              agent.communication.allowedAgentIds.length === allowedAgentIds.length &&
              agent.communication.allowedAgentIds.every((agentId, index) => agentId === allowedAgentIds[index])
            ) {
              return Promise.resolve();
            }

            return updateAgent(agent.id, agentToInput(agent, { allowAll, allowedAgentIds }));
          }),
        );
        await onAgentsChanged();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not save communication graph.");
        const configEdges = createCommunicationEdges(agents);
        setEdges(configEdges);
        await onAgentsChanged();
      }
    },
    [agents, onAgentsChanged, setEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }

      const id = createEdgeId(connection.source, connection.target);
      const nextEdges = (() => {
        if (edges.some((edge) => edge.id === id)) {
          return edges;
        }

        return normalizeEdges([...edges, { ...connection, id, ...edgeOptions }], agents);
      })();
      void persistEdges(nextEdges);
    },
    [agents, edges, persistEdges],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (!newConnection.source || !newConnection.target || newConnection.source === newConnection.target) {
        return;
      }

      reconnectSuccessful.current = true;
      const nextEdges = normalizeEdges(
        reconnectEdge(oldEdge, newConnection, edges).map((edge) =>
          edge.id === oldEdge.id
            ? {
                ...edge,
                id: createEdgeId(newConnection.source, newConnection.target),
                ...edgeOptions,
              }
            : edge,
        ),
        agents,
      );
      void persistEdges(nextEdges);
    },
    [agents, edges, persistEdges],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      void persistEdges(edges.filter((edge) => edge.id !== edgeId));
    },
    [edges, persistEdges],
  );

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
        <h1 className="text-lg font-semibold">No agents to graph</h1>
        <p className="mt-1 text-sm text-muted-foreground">Create agents first, then wire their communication paths here.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent communication graph</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag from a card's right touch point to another card's left touch point. Right-click a connection to delete it.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/20">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            removeEdge(edge.id);
          }}
          onNodeDragStop={(_, draggedNode) => {
            setNodes((currentNodes) => {
              const nextNodes = currentNodes.map((node) =>
                node.id === draggedNode.id ? { ...node, position: draggedNode.position } : node,
              );
              writeStoredPositions(nextNodes);
              return nextNodes;
            });
          }}
          onReconnectStart={(_, edge) => {
            reconnectSuccessful.current = false;
            reconnectingEdgeId.current = edge.id;
          }}
          onReconnect={onReconnect}
          onReconnectEnd={() => {
            if (!reconnectSuccessful.current && reconnectingEdgeId.current) {
              void persistEdges(edges.filter((edge) => edge.id !== reconnectingEdgeId.current));
            }
            reconnectingEdgeId.current = null;
            reconnectSuccessful.current = true;
          }}
          fitView
          fitViewOptions={{ padding: 0.22 }}
          edgesReconnectable
          elementsSelectable
          deleteKeyCode={null}
        >
          <Background />
          <MiniMap pannable zoomable nodeStrokeWidth={3} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
