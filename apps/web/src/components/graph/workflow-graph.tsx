import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
} from '@xyflow/react';
import type { WorkflowGraph, WorkflowGraphNode, WorkflowStepRunStatus } from 'agentdock-sdk/schemas';
import { CircleDot, Flag, Play } from 'lucide-react';
import { useMemo } from 'react';
import { GraphNodeCard } from '@/components/graph/node-card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Read-only rendering of a workflow's declared topology.
 *
 * The graph comes from the registry exactly as LangGraph described it — this
 * view adds layout and run status and nothing else. It is not an editor: the
 * artifact folder is the source of truth, and a picture that could be dragged
 * into disagreeing with the code would be worse than no picture.
 */

const STEP_WIDTH = 256;
const STEP_HEIGHT = 124;
const TERMINAL_WIDTH = 110;
const TERMINAL_HEIGHT = 44;

/** What the graph shows of a step's run: its status, how often it ran, how many runs are in progress. */
export type StepRunView = {
  readonly status: WorkflowStepRunStatus;
  readonly executions: number;
  readonly running: number;
};

type StepNodeData = {
  readonly label: string;
  readonly kind: string;
  readonly nodeId: string;
  readonly run: StepRunView | undefined;
  readonly selected: boolean;
};

/** An expanded subgraph node: the frame around its nodes, standing for the step that ran them. */
type FrameNodeData = {
  readonly label: string;
  readonly stepId: string;
  readonly run: StepRunView | undefined;
  readonly selected: boolean;
  readonly width: number;
  readonly height: number;
};

type TerminalNodeData = {
  readonly label: string;
  readonly terminal: 'start' | 'end';
  /** A subgraph's own start or end, inside its frame: edges run through it. */
  readonly nested: boolean;
};

type WorkflowNode = Node<StepNodeData, 'step'> | Node<TerminalNodeData, 'terminal'> | Node<FrameNodeData, 'frame'>;

/** How often a step ran (a loop's rounds, a fan-out's branches) and how many of those runs are going on. */
function RunBadges({ run }: { run: StepRunView | undefined }) {
  if (run === undefined) return null;
  return (
    <>
      {run.executions > 1 ? <Badge variant="outline">×{run.executions}</Badge> : null}
      {run.running > 1 ? <Badge variant="outline">{run.running} running</Badge> : null}
    </>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData, 'step'>>) {
  return (
    <GraphNodeCard
      kind={data.kind}
      icon={<CircleDot className="size-4" />}
      label={data.label}
      nodeId={data.nodeId}
      status={data.run?.status}
      selected={data.selected}
      badges={<RunBadges run={data.run} />}
    />
  );
}

const frameBorder = (run: StepRunView | undefined, selected: boolean): string => {
  if (selected) return 'border-primary';
  switch (run?.status) {
    case 'running':
      return 'border-primary';
    case 'waiting':
      return 'border-warning';
    case 'completed':
      return 'border-success/60';
    case 'failed':
      return 'border-destructive';
    default:
      return 'border-border';
  }
};

function FrameNode({ data }: NodeProps<Node<FrameNodeData, 'frame'>>) {
  return (
    <div
      className={cn('rounded-2xl border-2 border-dashed bg-muted/20', frameBorder(data.run, data.selected))}
      style={{ width: data.width, height: data.height }}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-xs font-semibold text-muted-foreground">
        <span className="font-mono">{data.label}</span>
        {data.run ? <Badge variant="secondary">{data.run.status}</Badge> : null}
        <RunBadges run={data.run} />
      </div>
    </div>
  );
}

function TerminalNode({ data }: NodeProps<Node<TerminalNodeData, 'terminal'>>) {
  const isStart = data.terminal === 'start';
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium shadow-sm',
        isStart ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {isStart ? <Play className="size-3" /> : <Flag className="size-3" />}
      {data.label}
      {isStart && !data.nested ? null : <Handle type="target" position={Position.Left} />}
      {isStart || data.nested ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

const nodeTypes: NodeTypes = { step: StepNode, terminal: TerminalNode, frame: FrameNode };

/** The graph's start and end, and a subgraph's own, which LangGraph draws as plain nodes named after them. */
const terminalOf = (node: WorkflowGraphNode): 'start' | 'end' | undefined => {
  if (node.kind === 'start' || node.name === '__start__') return 'start';
  if (node.kind === 'end' || node.name === '__end__') return 'end';
  return undefined;
};

const isTerminal = (node: WorkflowGraphNode): boolean => terminalOf(node) !== undefined;

/** Subgraph membership is shown by its frame; the card says what kind of node it is. */
const nodeKindLabel = (node: WorkflowGraphNode): string => (node.kind === 'io' ? 'io' : 'step');

/** Every subgraph a node sits in, outermost first: `a:b` for a node of `a:b` is in `a` and `a:b`. */
const enclosingGroups = (group: string | null): ReadonlyArray<string> =>
  group === null ? [] : group.split(':').map((_, index, parts) => parts.slice(0, index + 1).join(':'));

const depthOf = (group: string): number => group.split(':').length;
const frameId = (group: string): string => `frame:${group}`;
const FRAME_PADDING = 24;
const FRAME_LABEL = 28;

/** A placed box, by its top-left corner. */
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

type Placement = { readonly nodes: ReadonlyMap<string, Rect>; readonly frames: ReadonlyMap<string, Rect> };

const nodeSize = (node: WorkflowGraphNode) =>
  isTerminal(node) ? { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT } : { width: STEP_WIDTH, height: STEP_HEIGHT };

const padded = (rect: Rect, pad: number): Rect => ({
  x: rect.x - pad,
  y: rect.y - pad - FRAME_LABEL,
  width: rect.width + pad * 2,
  height: rect.height + pad * 2 + FRAME_LABEL,
});

const boundingBox = (rects: ReadonlyArray<Rect>): Rect => {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const overlaps = (left: Rect, right: Rect): boolean =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

/**
 * Dagre lays out the declared edges, left to right because `GraphNodeCard`
 * puts its handles on the card's sides (the shared card is not this view's to
 * reshape). With `clusters`, each expanded subgraph is a cluster dagre keeps
 * clear of other nodes, at the price of extra ranks for its borders; without,
 * its frame is the box around its nodes.
 */
const place = (graph: WorkflowGraph, groups: ReadonlyArray<string>, clusters: boolean): Placement => {
  const dag = new dagre.graphlib.Graph({ compound: clusters });
  dag.setDefaultEdgeLabel(() => ({}));
  dag.setGraph({ rankdir: 'LR', ranksep: 96, nodesep: 40, marginx: 32, marginy: 48 });
  if (clusters) {
    for (const group of groups) {
      dag.setNode(frameId(group), {});
      const outer = enclosingGroups(group).at(-2);
      if (outer !== undefined) dag.setParent(frameId(group), frameId(outer));
    }
  }
  for (const node of graph.nodes) {
    dag.setNode(node.id, nodeSize(node));
    if (clusters && node.group !== null) dag.setParent(node.id, frameId(node.group));
  }
  for (const edge of graph.edges) {
    dag.setEdge(edge.source, edge.target);
  }
  dagre.layout(dag);

  const centered = (id: string, size: { readonly width: number; readonly height: number }): Rect => {
    const placed = dag.node(id);
    return { x: placed.x - size.width / 2, y: placed.y - size.height / 2, ...size };
  };
  const nodes = new Map(graph.nodes.map((node) => [node.id, centered(node.id, nodeSize(node))] as const));
  const frames = new Map<string, Rect>();
  // Inner frames first, so an outer frame's box can take them in.
  for (const group of [...groups].sort((left, right) => depthOf(right) - depthOf(left))) {
    const pad = FRAME_PADDING / depthOf(group);
    if (clusters) {
      const cluster = dag.node(frameId(group));
      frames.set(group, padded(centered(frameId(group), { width: cluster.width, height: cluster.height }), pad));
      continue;
    }
    const members = [
      ...graph.nodes.flatMap((node) => (node.group === group ? [nodes.get(node.id)].filter(isDefined) : [])),
      ...groups.flatMap((inner) =>
        enclosingGroups(inner).at(-2) === group ? [frames.get(inner)].filter(isDefined) : [],
      ),
    ];
    frames.set(group, padded(boundingBox(members), pad));
  }
  return { nodes, frames };
};

const isDefined = <A,>(value: A | undefined): value is A => value !== undefined;

/** A frame drawn as a box around its nodes must not take in a node of another subgraph. */
const framesStayClear = (graph: WorkflowGraph, placement: Placement): boolean =>
  [...placement.frames].every(([group, frame]) =>
    graph.nodes.every((node) => {
      const rect = placement.nodes.get(node.id);
      return enclosingGroups(node.group).includes(group) || rect === undefined || !overlaps(frame, rect);
    }),
  );

const layout = (
  graph: WorkflowGraph,
  progress: ReadonlyMap<string, StepRunView> | undefined,
  selectedStepId: string | null,
) => {
  const groups = [...new Set(graph.nodes.flatMap((node) => enclosingGroups(node.group)))];
  const boxed = place(graph, groups, false);
  const placement = framesStayClear(graph, boxed) ? boxed : place(graph, groups, true);

  // Outer frames first, so inner frames and the steps draw on top of them.
  const frames = [...groups]
    .sort((left, right) => depthOf(left) - depthOf(right))
    .flatMap((group): ReadonlyArray<WorkflowNode> => {
      const rect = placement.frames.get(group);
      if (rect === undefined) return [];
      return [
        {
          id: frameId(group),
          type: 'frame',
          position: { x: rect.x, y: rect.y },
          draggable: false,
          zIndex: -2 + depthOf(group) / 10,
          data: {
            label: group.split(':').at(-1) ?? group,
            stepId: group,
            run: progress?.get(group),
            selected: selectedStepId === group,
            width: rect.width,
            height: rect.height,
          },
        },
      ];
    });

  const nodes = graph.nodes.map((node): WorkflowNode => {
    const rect = placement.nodes.get(node.id);
    const position = { x: rect?.x ?? 0, y: rect?.y ?? 0 };

    const terminal = terminalOf(node);
    if (terminal !== undefined) {
      return {
        id: node.id,
        type: 'terminal',
        position,
        draggable: false,
        data: { label: terminal === 'start' ? 'Start' : 'End', terminal, nested: node.group !== null },
      };
    }

    return {
      id: node.id,
      type: 'step',
      position,
      draggable: false,
      data: {
        label: node.name,
        kind: nodeKindLabel(node),
        nodeId: node.id,
        run: progress?.get(node.id),
        selected: selectedStepId === node.id,
      },
    };
  });

  const edges = graph.edges.map((edge, index): Edge => {
    const running = progress?.get(edge.target)?.status === 'running';
    return {
      id: `${edge.source}->${edge.target}#${index}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: running,
      label: edge.label ?? undefined,
      style: edge.conditional ? { strokeDasharray: '6 4' } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });

  return { nodes: [...frames, ...nodes], edges };
};

export function WorkflowGraphCanvas({
  graph,
  progress,
  selectedStepId = null,
  onSelectStep,
}: {
  graph: WorkflowGraph;
  progress?: ReadonlyMap<string, StepRunView> | undefined;
  selectedStepId?: string | null;
  onSelectStep?: ((stepId: string) => void) | undefined;
}) {
  const { nodes, edges } = useMemo(() => layout(graph, progress, selectedStepId), [graph, progress, selectedStepId]);

  return (
    <ReactFlow
      nodes={[...nodes]}
      edges={[...edges]}
      nodeTypes={nodeTypes}
      fitView
      // Expanded subgraphs make a graph wide; the default floor of 0.5 would keep part of it out of view.
      minZoom={0.1}
      nodesConnectable={false}
      elementsSelectable={onSelectStep !== undefined}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        if (node.type === 'step') onSelectStep?.(node.id);
        if (node.type === 'frame') onSelectStep?.(node.data.stepId);
      }}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
