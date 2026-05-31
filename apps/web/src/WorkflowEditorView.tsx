import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Bot, FileInput, FileOutput, GitBranch, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addWorkflow, removeWorkflow, updateWorkflow, workflowA2aUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Agent, CreateWorkflowInput, Workflow, WorkflowNode, WorkflowNodeType } from "agentdock-sdk/api";

type WorkflowNodeData = Record<string, unknown> & {
  readonly node: WorkflowNode;
  readonly agent: Agent | null;
};

type EditorNode = Node<WorkflowNodeData, "workflow">;
type WorkflowEdgeData = Record<string, unknown> & { readonly condition?: "true" | "false" };
type EditorEdge = Edge<WorkflowEdgeData>;

const edgeOptions = {
  type: "smoothstep",
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed },
} satisfies Partial<Edge>;

const createEdgeId = (source: string, target: string): string => `${source}->${target}`;

const defaultGraph = (agents: ReadonlyArray<Agent>): CreateWorkflowInput["graph"] => ({
  nodes: [
    { id: "input", type: "input", position: { x: 40, y: 160 }, data: { label: "Incoming task" } },
    {
      id: "agent",
      type: "agent",
      position: { x: 360, y: 130 },
      data: { label: "Ask agent", ...(agents[0] ? { agentId: agents[0].id } : {}), template: "{{input}}" },
    },
    { id: "output", type: "output", position: { x: 700, y: 160 }, data: { label: "Final result", template: "{{agent}}" } },
  ],
  edges: [
    { id: "input->agent", source: "input", target: "agent" },
    { id: "agent->output", source: "agent", target: "output" },
  ],
});

const createWorkflowInput = (agents: ReadonlyArray<Agent>): CreateWorkflowInput => ({
  name: "New workflow",
  description: "A workflow that receives an A2A task, runs nodes, and returns a text result.",
  version: "0.1.0",
  graph: defaultGraph(agents),
});

const iconForNode = (type: WorkflowNodeType) => {
  switch (type) {
    case "input":
      return <FileInput className="size-4" />;
    case "agent":
      return <Bot className="size-4" />;
    case "template":
      return <Sparkles className="size-4" />;
    case "condition":
      return <GitBranch className="size-4" />;
    case "output":
      return <FileOutput className="size-4" />;
  }
};

function WorkflowCard({ data, selected }: NodeProps<EditorNode>) {
  return (
    <div
      className={cn(
        "relative w-64 rounded-xl border bg-card p-4 text-card-foreground shadow-lg transition-colors",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-4 !border-2 !border-background !bg-primary" />
      <Handle type="source" position={Position.Right} className="!size-4 !border-2 !border-background !bg-primary" />
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          {iconForNode(data.node.type)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data.node.data.label}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{data.node.id}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="secondary">{data.node.type}</Badge>
        {data.node.type === "agent" ? <Badge variant="outline">{data.agent?.name ?? "missing agent"}</Badge> : null}
      </div>
      {data.node.data.template ? (
        <p className="mt-3 line-clamp-2 font-mono text-[11px] text-muted-foreground">{data.node.data.template}</p>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  workflow: WorkflowCard,
} satisfies NodeTypes;

const toEditorNodes = (workflow: Workflow | CreateWorkflowInput, agents: ReadonlyArray<Agent>): Array<EditorNode> =>
  workflow.graph.nodes.map((node) => ({
    id: node.id,
    type: "workflow",
    position: node.position,
    data: { node, agent: agents.find((agent) => agent.id === node.data.agentId) ?? null },
  }));

const toEditorEdges = (workflow: Workflow | CreateWorkflowInput): Array<EditorEdge> =>
  workflow.graph.edges.map((edge) => ({
    ...edge,
    ...edgeOptions,
    label: edge.condition,
    data: { ...(edge.condition ? { condition: edge.condition } : {}) },
  }));

export function WorkflowEditorView({
  workflows,
  agents,
  onWorkflowsChanged,
}: {
  workflows: ReadonlyArray<Workflow>;
  agents: ReadonlyArray<Agent>;
  onWorkflowsChanged: () => Promise<void>;
}) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | "new">(() => workflows[0]?.id ?? "new");
  const didAutoSelectInitialWorkflow = useRef(workflows.length > 0);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;
  const [draft, setDraft] = useState<CreateWorkflowInput>(() => selectedWorkflow ?? createWorkflowInput(agents));
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(toEditorNodes(draft, agents));
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(toEditorEdges(draft));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(draft.graph.nodes[0]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedWorkflowId === "new" && !didAutoSelectInitialWorkflow.current && workflows[0]) {
      didAutoSelectInitialWorkflow.current = true;
      setSelectedWorkflowId(workflows[0].id);
      return;
    }

    if (selectedWorkflowId !== "new" && !selectedWorkflow && workflows[0]) {
      setSelectedWorkflowId(workflows[0].id);
      return;
    }

    const nextDraft = selectedWorkflow ?? createWorkflowInput(agents);
    setDraft(nextDraft);
    setNodes(toEditorNodes(nextDraft, agents));
    setEdges(toEditorEdges(nextDraft));
    setSelectedNodeId(nextDraft.graph.nodes[0]?.id ?? null);
  }, [agents, selectedWorkflow, selectedWorkflowId, setEdges, setNodes, workflows]);

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          agent: agents.find((agent) => agent.id === node.data.node.data.agentId) ?? null,
        },
      })),
    );
  }, [agents, setNodes]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;

  const updateSelectedNode = (partial: Partial<WorkflowNode["data"]>) => {
    if (!selectedNode) return;
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        if (node.id !== selectedNode.id) {
          return node;
        }
        const nextWorkflowNode = { ...node.data.node, data: { ...node.data.node.data, ...partial } };
        return {
          ...node,
          data: {
            node: nextWorkflowNode,
            agent: agents.find((agent) => agent.id === nextWorkflowNode.data.agentId) ?? null,
          },
        };
      }),
    );
  };

  const addNode = (type: WorkflowNodeType) => {
    const id = `${type}-${crypto.randomUUID().slice(0, 6)}`;
    const node: WorkflowNode = {
      id,
      type,
      position: { x: 180 + nodes.length * 36, y: 80 + nodes.length * 28 },
      data: {
        label: type === "agent" ? "Ask agent" : type === "template" ? "Template" : type === "condition" ? "If / else" : type === "output" ? "Final result" : "Input",
        ...(type === "agent" ? { ...(agents[0] ? { agentId: agents[0].id } : {}), template: "{{input}}" } : {}),
        ...(type === "template" || type === "output" ? { template: "{{input}}" } : {}),
        ...(type === "condition" ? { conditionExpression: "urgent" } : {}),
      },
    };
    setNodes((currentNodes) => [...currentNodes, { id, type: "workflow", position: node.position, data: { node, agent: null } }]);
    setSelectedNodeId(id);
  };

  const removeSelectedNode = () => {
    if (!selectedNode || selectedNode.data.node.type === "input") return;
    setNodes((currentNodes) => currentNodes.filter((node) => node.id !== selectedNode.id));
    setEdges((currentEdges) => currentEdges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedNodeId(null);
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const id = createEdgeId(connection.source, connection.target);
      setEdges((currentEdges) =>
        currentEdges.some((edge) => edge.id === id)
          ? currentEdges
          : [...currentEdges, { id, source: connection.source!, target: connection.target!, ...edgeOptions, data: {} }],
      );
    },
    [setEdges],
  );

  const workflowInput = useMemo<CreateWorkflowInput>(() => ({
    ...draft,
    graph: {
      nodes: nodes.map((node) => ({ ...node.data.node, position: node.position })),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, ...(edge.data?.condition ? { condition: edge.data.condition } : {}) })),
    },
  }), [draft, edges, nodes]);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const saved = selectedWorkflow ? await updateWorkflow(selectedWorkflow.id, workflowInput) : await addWorkflow(workflowInput);
      setSelectedWorkflowId(saved.id);
      await onWorkflowsChanged();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not save workflow.");
    } finally {
      setPending(false);
    }
  };

  const removeCurrentWorkflow = async () => {
    if (!selectedWorkflow) return;
    setPending(true);
    setError(null);
    try {
      await removeWorkflow(selectedWorkflow.id);
      setSelectedWorkflowId("new");
      await onWorkflowsChanged();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not delete workflow.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflow editor</h1>
          <p className="mt-1 text-sm text-muted-foreground">Build workflow graphs separately from agent communication rules. Agent nodes call A2A agents and stream progress.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={selectedWorkflowId} onValueChange={(value) => setSelectedWorkflowId(value)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select workflow" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">New workflow</SelectItem>
              {workflows.map((workflow) => (
                <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="secondary" onClick={() => setSelectedWorkflowId("new")}>New</Button>
          <Button onClick={save} disabled={pending}><Save className="size-4" />{pending ? "Saving..." : "Save"}</Button>
          {selectedWorkflow ? <Button variant="ghost" onClick={removeCurrentWorkflow} disabled={pending} className="text-destructive"><Trash2 className="size-4" />Delete</Button> : null}
        </div>
      </div>

      {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_1fr_320px]">
        <div className="space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-4">
          <Field label="Name" htmlFor="workflow-name">
            <Input id="workflow-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Description" htmlFor="workflow-description">
            <Textarea id="workflow-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="min-h-20" />
          </Field>
          <Field label="Version" htmlFor="workflow-version">
            <Input id="workflow-version" value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} />
          </Field>
          {selectedWorkflow ? <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">{workflowA2aUrl(selectedWorkflow.id)}</div> : null}
          <div className="grid grid-cols-2 gap-2 border-t border-border/60 pt-4">
            <Button type="button" variant="secondary" onClick={() => addNode("template")}><Plus className="size-4" />Template</Button>
            <Button type="button" variant="secondary" onClick={() => addNode("condition")}><Plus className="size-4" />If / else</Button>
            <Button type="button" variant="secondary" onClick={() => addNode("agent")}><Plus className="size-4" />Agent</Button>
            <Button type="button" variant="secondary" onClick={() => addNode("output")}><Plus className="size-4" />Output</Button>
          </div>
        </div>

        <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-muted/20">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setEdges((currentEdges) => currentEdges.filter((candidate) => candidate.id !== edge.id));
            }}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            deleteKeyCode={null}
          >
            <Background />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
            <Controls />
          </ReactFlow>
        </div>

        <div className="space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-4">
          {selectedNode ? (
            <>
              <div>
                <h2 className="font-semibold">Selected node</h2>
                <p className="font-mono text-xs text-muted-foreground">{selectedNode.id}</p>
              </div>
              <Field label="Label" htmlFor="node-label">
                <Input id="node-label" value={selectedNode.data.node.data.label} onChange={(event) => updateSelectedNode({ label: event.target.value })} />
              </Field>
              {selectedNode.data.node.type === "agent" ? (
                <Field label="Agent" htmlFor="node-agent">
                  <Select value={selectedNode.data.node.data.agentId ?? ""} onValueChange={(agentId) => updateSelectedNode({ agentId })}>
                    <SelectTrigger id="node-agent"><SelectValue placeholder="Select agent" /></SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              {selectedNode.data.node.type === "condition" ? (
                <Field label="Condition" htmlFor="node-condition" description="True when input contains this text. Use /regex/ for regex matching.">
                  <Input id="node-condition" value={selectedNode.data.node.data.conditionExpression ?? ""} onChange={(event) => updateSelectedNode({ conditionExpression: event.target.value })} />
                </Field>
              ) : null}
              {selectedNode.data.node.type !== "input" && selectedNode.data.node.type !== "condition" ? (
                <Field label="Template" htmlFor="node-template" description="Use {{input}} or {{node-id}} placeholders.">
                  <Textarea id="node-template" value={selectedNode.data.node.data.template ?? ""} onChange={(event) => updateSelectedNode({ template: event.target.value })} className="min-h-32 font-mono text-sm" />
                </Field>
              ) : null}
              <Button type="button" variant="ghost" onClick={removeSelectedNode} disabled={selectedNode.data.node.type === "input"} className="w-full text-destructive">
                <Trash2 className="size-4" />Remove node
              </Button>
            </>
          ) : selectedEdge ? (
            <>
              <div>
                <h2 className="font-semibold">Selected edge</h2>
                <p className="font-mono text-xs text-muted-foreground">{selectedEdge.source} -&gt; {selectedEdge.target}</p>
              </div>
              <Field label="Branch" htmlFor="edge-condition" description="Use true/false for condition node branches; leave empty for normal flow.">
                <Select
                  value={selectedEdge.data?.condition ?? "always"}
                  onValueChange={(condition) =>
                    setEdges((currentEdges) =>
                      currentEdges.map((edge) =>
                        edge.id === selectedEdge.id
                          ? {
                              ...edge,
                              label: condition === "always" ? undefined : condition,
                              data: condition === "always" ? {} : { condition: condition as "true" | "false" },
                            }
                          : edge,
                      ),
                    )
                  }
                >
                  <SelectTrigger id="edge-condition"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">Always</SelectItem>
                    <SelectItem value="true">True</SelectItem>
                    <SelectItem value="false">False</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Select a node or edge to edit its data mapping.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, htmlFor, description, children }: { label: string; htmlFor: string; description?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium">{label}</Label>
      {children}
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
    </div>
  );
}
