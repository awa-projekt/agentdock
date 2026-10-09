import type { AgentRecord, Workflow } from 'agentdock-sdk/schemas';

/** A chat-addressable target: either a registered agent or a workflow. */
export type ChatTarget =
  | { kind: 'agent'; id: string; name: string; description: string; url: string; agent: AgentRecord }
  | { kind: 'workflow'; id: string; name: string; description: string; url: string; workflow: Workflow };

export const agentTargetId = (agentId: string): string => `agent:${agentId}`;
export const workflowTargetId = (workflowId: string): string => `workflow:${workflowId}`;
