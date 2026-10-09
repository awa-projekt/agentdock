import { Handle, Position, useConnection } from '@xyflow/react';
import type { WorkflowStepRunStatus } from 'agentdock-sdk/schemas';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Border treatment per run status; undefined status renders the neutral look. */
const statusBorder = (status: WorkflowStepRunStatus | undefined, selected: boolean): string => {
  if (selected) {
    return 'border-primary ring-2 ring-primary/20';
  }

  switch (status) {
    case 'running':
      return 'border-primary ring-2 ring-primary/30';
    case 'waiting':
      return 'border-warning ring-2 ring-warning/30';
    case 'completed':
      return 'border-success';
    case 'failed':
      return 'border-destructive';
    case 'canceled':
      return 'border-border opacity-60';
    default:
      return 'border-border';
  }
};

/** A single input/output socket. */
export type NodePort = {
  readonly id: string;
  readonly label?: string | undefined;
  readonly isConnectableEnd?: boolean | undefined;
};

const DEFAULT_INPUTS: ReadonlyArray<NodePort> = [{ id: 'in' }];
const DEFAULT_OUTPUTS: ReadonlyArray<NodePort> = [{ id: 'out' }];

/** Even vertical placement for `count` handles along a node edge (e.g. 33%/67% for two). */
const portTop = (index: number, count: number): string => `${((index + 1) / (count + 1)) * 100}%`;

/**
 * Presentational graph node card. Deliberately knows nothing about what a node
 * *is* — callers pass an icon and a kind label — so it serves the agent
 * topology graph and the workflow step timeline equally, without either
 * dragging in the other's vocabulary.
 */
export function GraphNodeCard({
  kind,
  icon,
  label,
  nodeId,
  status,
  accentColor,
  selected = false,
  badges,
  detail,
  inputs = DEFAULT_INPUTS,
  outputs = DEFAULT_OUTPUTS,
  children,
}: {
  kind: string;
  icon: ReactNode;
  label: string;
  nodeId: string;
  status?: WorkflowStepRunStatus | undefined;
  accentColor?: string | undefined;
  selected?: boolean;
  badges?: ReactNode;
  detail?: string | null | undefined;
  inputs?: ReadonlyArray<NodePort> | undefined;
  outputs?: ReadonlyArray<NodePort> | undefined;
  children?: ReactNode;
}) {
  const connectionInProgress = useConnection((connection) => connection.inProgress);

  return (
    <div
      className={cn(
        'relative w-64 rounded-xl border bg-card p-4 text-card-foreground shadow-lg transition-colors',
        statusBorder(status, selected),
        connectionInProgress && 'graph-node-connecting',
      )}
    >
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: portTop(index, inputs.length), backgroundColor: accentColor }}
          title={port.label ?? port.id}
          isConnectableEnd={port.isConnectableEnd}
          className="graph-node-port !size-4 !border-2 !border-background !bg-primary"
        />
      ))}
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: portTop(index, outputs.length), backgroundColor: accentColor }}
          title={port.label ?? port.id}
          isConnectableEnd={port.isConnectableEnd}
          className="graph-node-port !size-4 !border-2 !border-background !bg-primary"
        />
      ))}
      {outputs.length > 1
        ? outputs.map((port, index) => (
            <span
              key={`${port.id}-label`}
              className="pointer-events-none absolute right-3 -translate-y-1/2 text-[9px] font-medium text-muted-foreground"
              style={{ top: portTop(index, outputs.length) }}
            >
              {port.label ?? port.id}
            </span>
          ))
        : null}
      <div className="flex items-start gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
          style={accentColor ? { backgroundColor: `${accentColor}20`, color: accentColor } : undefined}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{label}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{nodeId}</div>
        </div>
        {status === 'running' ? (
          <span
            role="status"
            className="mt-1 size-2.5 shrink-0 animate-pulse rounded-full bg-primary"
            aria-label="running"
          />
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="secondary">{kind}</Badge>
        {badges}
      </div>
      {detail ? <p className="mt-3 line-clamp-2 font-mono text-[11px] text-muted-foreground">{detail}</p> : null}
      {children}
    </div>
  );
}
