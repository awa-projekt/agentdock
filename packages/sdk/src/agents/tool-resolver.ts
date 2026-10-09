import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import type { IntegrationOverrides } from '../schemas/integrations';
import type { JsonSerializableObject } from '../schemas/json';
import type { AgentToolSet } from '../tools';
import type { AgentDefinition } from './definition';

/**
 * Per-request context handed to tool resolution and, from there, to any tool
 * that needs to relay activity onto the caller's event stream (e.g.
 * `send_task` nesting a subagent's progress under the call).
 */
export type WorkflowToolInvocation = {
  readonly workflowId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly stepId: string;
};

export type AgentToolContext = {
  readonly deployment?: import('../runtime/types').GraphDeployment | undefined;
  readonly taskId: string;
  readonly contextId: string;
  readonly userMessageId: string;
  readonly emit?: ((data: JsonSerializableObject) => void) | undefined;
  readonly workflow?: WorkflowToolInvocation | undefined;
  /** Integrations this run reaches somewhere else than registered; see {@link IntegrationOverrides}. */
  readonly integrations?: IntegrationOverrides | undefined;
};

export class ToolResolverError extends Schema.TaggedError<ToolResolverError>()('ToolResolverError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

/**
 * Resolves the tool set an agent runs with for a given invocation. Swappable
 * so hosts can wire tool discovery (executor integrations, skills, a2a peers)
 * while local/eval callers can just hand a fixed list.
 */
export class AgentToolResolver extends Context.Service<
  AgentToolResolver,
  {
    readonly resolve: (
      agent: AgentDefinition,
      context: AgentToolContext,
    ) => Effect.Effect<AgentToolSet, ToolResolverError>;
  }
>()('agentdock-sdk/agents/tool-resolver/AgentToolResolver') {
  /**
   * Always resolves to exactly the tools passed in (or computed from the
   * agent, when a function is given) — no default tools are added. For
   * local/eval use where the caller owns the full tool set.
   */
  static readonly static = (
    tools: AgentToolSet | ((agent: AgentDefinition) => AgentToolSet),
  ): Layer.Layer<AgentToolResolver> =>
    Layer.succeed(
      AgentToolResolver,
      AgentToolResolver.of({
        resolve: (agent) => Effect.succeed(Predicate.isFunction(tools) ? tools(agent) : tools),
      }),
    );
}
