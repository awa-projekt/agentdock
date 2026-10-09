import { useMutation } from '@tanstack/react-query';
import {
  Background,
  BaseEdge,
  type Connection,
  Controls,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  ReactFlow,
  reconnectEdge,
  useConnection,
  useEdges,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import type { AgentColor, AgentRecord, CreateAgentInput } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { Bot } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentColorPicker } from '@/components/agent-color-picker';
import { EmptyState } from '@/components/EmptyState';
import { GraphNodeCard } from '@/components/graph/node-card';
import { useReleaseRepel } from '@/components/graph/use-release-repel';
import { ScreenSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { ErrorBanner, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePersistedFlag } from '@/hooks/use-ui-preferences';
import { updateAgent } from '@/lib/api';
import { toErrorMessage } from '@/lib/format';
import { queryKeys, useAgents, useInvalidate, useUpdateAgent } from '@/lib/queries';

type AgentNodeData = {
  readonly agent: AgentRecord;
  readonly outgoingCount: number;
  readonly incomingCount: number;
  readonly allowAll: boolean;
  readonly colorSaving: boolean;
  readonly onColorChange: (color: AgentColor) => void;
};

type AgentNode = Node<AgentNodeData, 'agent'>;

const GraphPosition = Schema.Struct({ x: Schema.Number, y: Schema.Number });
type GraphPosition = typeof GraphPosition.Type;

const StoredGraphPositions = Schema.fromJsonString(Schema.Record(Schema.String, GraphPosition));
const decodeStoredPositions = Schema.decodeUnknownOption(StoredGraphPositions);

type CommunicationEdgeData = { readonly separated: boolean };
type CommunicationEdge = Edge<CommunicationEdgeData, 'communication'>;

const GRAPH_POSITIONS_STORAGE_KEY = 'agentdock-agent-graph-positions';

const edgeOptions = {
  type: 'communication',
  animated: true,
  zIndex: 0,
} satisfies Partial<CommunicationEdge>;

const createEdgeId = (source: string, target: string): string => `${source}->${target}`;

const readStoredPositions = (): Record<string, GraphPosition> =>
  Option.getOrElse(decodeStoredPositions(window.localStorage.getItem(GRAPH_POSITIONS_STORAGE_KEY)), () => ({}));

const writeStoredPositions = (nodes: ReadonlyArray<AgentNode>): void => {
  const positions = Object.fromEntries(nodes.map((node) => [node.id, node.position]));
  window.localStorage.setItem(GRAPH_POSITIONS_STORAGE_KEY, JSON.stringify(positions));
};

const createInitialNodes = ({
  agents,
  previousNodes,
  edges,
  storedPositions,
  updatingColorAgentId,
  onColorChange,
}: {
  readonly agents: ReadonlyArray<AgentRecord>;
  readonly previousNodes: ReadonlyArray<AgentNode>;
  readonly edges: ReadonlyArray<Edge>;
  readonly storedPositions: Record<string, GraphPosition>;
  readonly updatingColorAgentId: string | undefined;
  readonly onColorChange: (agent: AgentRecord, color: AgentColor) => void;
}): Array<AgentNode> => {
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
      type: 'agent',
      position: previous?.position ??
        storedPositions[agent.id] ?? {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        },
      data: {
        agent,
        outgoingCount,
        incomingCount,
        allowAll: agent.communication.allowAll,
        colorSaving: updatingColorAgentId === agent.id,
        onColorChange: (color) => onColorChange(agent, color),
      },
    };
  });
};

const toCommunicationEdges = (
  connections: ReadonlyArray<{ readonly source: string; readonly target: string }>,
  agents: ReadonlyArray<AgentRecord>,
): Array<CommunicationEdge> => {
  const colorByAgentId = new Map<string, AgentColor>(agents.map((agent) => [agent.id, agent.color]));
  const connectionIds = new Set(connections.map(({ source, target }) => createEdgeId(source, target)));

  return connections.map(({ source, target }) => {
    const color = colorByAgentId.get(source) ?? '#64748b';
    return {
      id: createEdgeId(source, target),
      source,
      target,
      ...edgeOptions,
      data: { separated: connectionIds.has(createEdgeId(target, source)) },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: 2.25 },
    };
  });
};

const createCommunicationEdges = (agents: ReadonlyArray<AgentRecord>): Array<CommunicationEdge> => {
  const agentIds = new Set<string>(agents.map((agent) => agent.id));
  const connections = new Map<string, { readonly source: string; readonly target: string }>();

  for (const agent of agents) {
    const targetIds = agent.communication.allowAll
      ? agents.map((target) => target.id).filter((targetId) => targetId !== agent.id)
      : agent.communication.allowedAgentIds.filter((targetId) => targetId !== agent.id && agentIds.has(targetId));

    for (const targetId of targetIds) {
      const id = createEdgeId(agent.id, targetId);
      connections.set(id, { source: agent.id, target: targetId });
    }
  }

  return toCommunicationEdges(Array.from(connections.values()), agents);
};

const agentToInput = (
  agent: AgentRecord,
  communication: AgentRecord['communication'],
  color: AgentColor = agent.color,
): CreateAgentInput => ({
  name: agent.name,
  description: agent.description,
  color,
  instructions: agent.instructions,
  model: agent.model,
  integrations: agent.integrations,
  skills: agent.skills,
  communication,
  version: agent.version,
  capabilities: agent.capabilities,
  defaultInputModes: agent.defaultInputModes,
  defaultOutputModes: agent.defaultOutputModes,
  inputContract: agent.inputContract ?? undefined,
  outputContract: agent.outputContract ?? undefined,
});

const normalizeEdges = (edges: ReadonlyArray<Edge>, agents: ReadonlyArray<AgentRecord>): Array<CommunicationEdge> => {
  const agentIds = new Set<string>(agents.map((agent) => agent.id));
  const connections = new Map<string, { readonly source: string; readonly target: string }>();

  for (const edge of edges) {
    if (!agentIds.has(edge.source) || !agentIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }

    const id = createEdgeId(edge.source, edge.target);
    connections.set(id, { source: edge.source, target: edge.target });
  }

  return toCommunicationEdges(Array.from(connections.values()), agents);
};

function CommunicationEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<CommunicationEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: data?.separated ? 0.35 : 0.25,
  });

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={20} />;
}

const edgeTypes = { communication: CommunicationEdge } satisfies EdgeTypes;

function AgentNodeCard({ data, selected }: NodeProps<AgentNode>) {
  const edges = useEdges<CommunicationEdge>();
  const fromNodeId = useConnection((connection) => (connection.inProgress ? connection.fromNode.id : null));
  const fromHandleType = useConnection((connection) => (connection.inProgress ? connection.fromHandle.type : null));
  const hasConnection = (source: string, target: string): boolean =>
    edges.some((edge) => edge.source === source && edge.target === target);
  const inputConnectable =
    fromHandleType !== 'source' ||
    fromNodeId === null ||
    (fromNodeId !== data.agent.id && !hasConnection(fromNodeId, data.agent.id));
  const outputConnectable =
    fromHandleType !== 'target' ||
    fromNodeId === null ||
    (fromNodeId !== data.agent.id && !hasConnection(data.agent.id, fromNodeId));

  return (
    <GraphNodeCard
      kind="agent"
      accentColor={data.agent.color}
      icon={<Bot className="size-4" />}
      label={data.agent.name}
      nodeId={data.agent.id}
      selected={selected}
      inputs={[{ id: 'in', isConnectableEnd: inputConnectable }]}
      outputs={[{ id: 'out', isConnectableEnd: outputConnectable }]}
      badges={
        <>
          <Badge variant={data.allowAll ? 'default' : 'secondary'}>
            {data.allowAll ? 'all targets' : `${data.outgoingCount} out`}
          </Badge>
          <Badge variant="outline">{data.incomingCount} in</Badge>
        </>
      }
    >
      <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{data.agent.description}</p>
      <div className="mt-3 flex items-center gap-2">
        <div className="nodrag nopan nowheel">
          <AgentColorPicker
            value={data.agent.color}
            onChange={data.onColorChange}
            label={`${data.agent.name} color`}
            compact
          />
        </div>
        <span className="text-xs font-medium text-muted-foreground">Color</span>
        {data.colorSaving ? <span className="text-[10px] text-muted-foreground">Saving…</span> : null}
      </div>
    </GraphNodeCard>
  );
}

const nodeTypes = {
  agent: AgentNodeCard,
} satisfies NodeTypes;

export function AgentGraphView() {
  const agentsQuery = useAgents();
  const agents = agentsQuery.data ?? [];
  const invalidate = useInvalidate();
  const { mutate: updateColor, isPending: colorSaving, variables: colorVariables } = useUpdateAgent();
  const [error, setError] = useState<string | null>(null);
  const updatingColorAgentId = colorSaving && colorVariables ? colorVariables.agentId : undefined;

  const changeAgentColor = useCallback(
    (agent: AgentRecord, color: AgentColor) => {
      setError(null);
      updateColor(
        { agentId: agent.id, input: agentToInput(agent, agent.communication, color) },
        { onError: (caught) => setError(caught.message) },
      );
    },
    [updateColor],
  );

  const initialEdges = useMemo(() => createCommunicationEdges(agents), [agents]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(
    createInitialNodes({
      agents,
      previousNodes: [],
      edges: initialEdges,
      storedPositions: readStoredPositions(),
      updatingColorAgentId,
      onColorChange: changeAgentColor,
    }),
  );
  const [repulsionEnabled, setRepulsionEnabled] = usePersistedFlag('agentdock-agent-graph-repel', false);
  const reconnectSuccessful = useRef(true);
  const reconnectingEdgeId = useRef<string | null>(null);

  useEffect(() => {
    const nextEdges = createCommunicationEdges(agents);
    setEdges(nextEdges);
    setNodes((currentNodes) =>
      createInitialNodes({
        agents,
        previousNodes: currentNodes,
        edges: nextEdges,
        storedPositions: readStoredPositions(),
        updatingColorAgentId,
        onColorChange: changeAgentColor,
      }),
    );
  }, [agents, changeAgentColor, setEdges, setNodes, updatingColorAgentId]);

  useEffect(() => {
    setNodes((currentNodes) =>
      createInitialNodes({
        agents,
        previousNodes: currentNodes,
        edges,
        storedPositions: readStoredPositions(),
        updatingColorAgentId,
        onColorChange: changeAgentColor,
      }),
    );
  }, [agents, changeAgentColor, edges, setNodes, updatingColorAgentId]);

  const saveCommunication = useMutation({
    mutationFn: (normalizedEdges: ReadonlyArray<Edge>) => {
      const orderedAgentIds = agents.map((agent) => agent.id);
      const targetsBySource = new Map<string, Set<string>>();

      for (const edge of normalizedEdges) {
        const targets = targetsBySource.get(edge.source) ?? new Set<string>();
        targets.add(edge.target);
        targetsBySource.set(edge.source, targets);
      }

      return Promise.all(
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
    },
    onSuccess: () => invalidate(queryKeys.agents),
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : 'Could not save communication graph.');
      setEdges(createCommunicationEdges(agents));
      return invalidate(queryKeys.agents);
    },
  });

  const persistEdges = useCallback(
    (nextEdges: ReadonlyArray<Edge>) => {
      const normalizedEdges = normalizeEdges(nextEdges, agents);
      setError(null);
      setEdges(normalizedEdges);
      saveCommunication.mutate(normalizedEdges);
    },
    [agents, saveCommunication, setEdges],
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
      persistEdges(nextEdges);
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
      persistEdges(nextEdges);
    },
    [agents, edges, persistEdges],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      persistEdges(edges.filter((edge) => edge.id !== edgeId));
    },
    [edges, persistEdges],
  );

  const isValidConnection = useCallback(
    (connection: Connection | CommunicationEdge) =>
      connection.source !== connection.target &&
      !edges.some((edge) => edge.source === connection.source && edge.target === connection.target),
    [edges],
  );

  const { flowNodes, onNodeDragStart, onNodeDragStop } = useReleaseRepel({
    nodes,
    setNodes,
    enabled: repulsionEnabled,
    settleAllKey: agents.map((agent) => agent.id).join(','),
    onNodesSettled: writeStoredPositions,
  });

  if (agentsQuery.isPending) return <ScreenSkeleton layout="graph" />;
  if (agentsQuery.isError)
    return <ErrorBanner>{toErrorMessage(agentsQuery.error, 'Could not load agents.')}</ErrorBanner>;

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agents to graph"
        description="Create agents first, then wire their communication paths here."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SectionHeader
        title="Agent communication graph"
        description="Drag from a card's right touch point to another card's left touch point. Right-click a connection to delete it."
        actions={
          <Button
            type="button"
            variant={repulsionEnabled ? 'default' : 'outline'}
            onClick={() => setRepulsionEnabled(!repulsionEnabled)}
            aria-pressed={repulsionEnabled}
            title="Slide a released agent node away from overlaps"
          >
            Repel {repulsionEnabled ? 'on' : 'off'}
          </Button>
        }
      />

      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/20">
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          edgeTypes={edgeTypes}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            removeEdge(edge.id);
          }}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onReconnectStart={(_, edge) => {
            reconnectSuccessful.current = false;
            reconnectingEdgeId.current = edge.id;
          }}
          onReconnect={onReconnect}
          onReconnectEnd={() => {
            if (!reconnectSuccessful.current && reconnectingEdgeId.current) {
              persistEdges(edges.filter((edge) => edge.id !== reconnectingEdgeId.current));
            }
            reconnectingEdgeId.current = null;
            reconnectSuccessful.current = true;
          }}
          fitView
          fitViewOptions={{ padding: 0.22 }}
          edgesReconnectable
          elevateEdgesOnSelect={false}
          elementsSelectable
          connectionRadius={32}
          reconnectRadius={32}
          deleteKeyCode={null}
        >
          <Background />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={3}
            nodeColor={(node) => agents.find((agent) => agent.id === node.id)?.color ?? '#64748b'}
          />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
