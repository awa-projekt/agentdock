import type { Message, Task } from '@a2a-js/sdk';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import type { AgentRecord, CatalogTool, ExternalA2aAgent, Workflow } from '../schemas';

export type GraphDeployment =
  | { readonly kind: 'agent'; readonly agent: AgentRecord; readonly agents: ReadonlyArray<AgentRecord> }
  | {
      readonly kind: 'workflow';
      readonly workflow: Workflow;
      /** Every agent the workflow's bindings (and its bound workflows' bindings) point at, and their delegation targets. */
      readonly agents: ReadonlyArray<AgentRecord>;
      readonly externalAgents: ReadonlyArray<ExternalA2aAgent>;
      readonly workflows: ReadonlyArray<Workflow>;
      /** Catalog tools the bindings point at, with their schemas. */
      readonly tools: ReadonlyArray<CatalogTool>;
    };

export const graphTarget = (deployment: GraphDeployment): string =>
  deployment.kind === 'agent' ? `agent:${deployment.agent.id}` : `workflow:${deployment.workflow.id}`;

export const graphThreadId = (target: string, contextId: string): string => JSON.stringify([target, contextId]);

export type GraphExecution = {
  readonly id: string;
  readonly target: string;
  readonly threadId: string;
  readonly contextId: string;
  readonly runtimeHash: string;
  readonly deployment: GraphDeployment;
  readonly message: Message;
  readonly task: Task | null;
  readonly status: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';
  readonly owner: string | null;
  readonly leaseUntil: number;
  readonly cancelRequested: boolean;
};

export type GraphExecutionEvent = {
  readonly requestId: string;
  readonly sequence: number;
  readonly event: AgentExecutionEvent;
};
