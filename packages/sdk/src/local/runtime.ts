import type * as Config from 'effect/Config';
import * as Layer from 'effect/Layer';
import type { AgentDefinition } from '../agents/definition';
import { AgentLoopFactoryLive } from '../agents/langgraph-loop';
import type { AgentLoopFactory } from '../agents/loop';
import { ModelProvider } from '../agents/model-provider';
import { AgentRunStore } from '../agents/run-store';
import { AgentToolResolver } from '../agents/tool-resolver';
import type { AgentToolSet } from '../tools';
import { WorkflowRunStore } from '../workflows/run-store';
import { type WorkflowToolInvoke, WorkflowToolInvoker } from '../workflows/tool-invoker';

export type LocalRuntimeOptions = {
  /** Passed straight through to `AgentToolResolver.static` — no default tools are added. */
  readonly tools?: AgentToolSet | ((agent: AgentDefinition) => AgentToolSet);
  /** Runs the integration tools a workflow binds; without it every bound tool fails when called. */
  readonly workflowTools?: WorkflowToolInvoke;
};

/** Every service `runAgent` and the workflow runtime need, all satisfied by `localRuntimeLayer`. */
export type LocalRuntimeServices =
  | AgentLoopFactory
  | ModelProvider
  | AgentToolResolver
  | AgentRunStore
  | WorkflowRunStore
  | WorkflowToolInvoker;

export const localRuntimeLayer = (
  options?: LocalRuntimeOptions,
): Layer.Layer<LocalRuntimeServices, Config.ConfigError> =>
  Layer.mergeAll(
    AgentLoopFactoryLive,
    ModelProvider.fromEnv,
    AgentToolResolver.static(options?.tools ?? []),
    AgentRunStore.inMemory,
    WorkflowRunStore.inMemory,
    options?.workflowTools ? WorkflowToolInvoker.make(options.workflowTools) : WorkflowToolInvoker.none,
  );
