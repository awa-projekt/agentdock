import type { GraphDeployment } from 'agentdock-sdk';
import type {
  AgentRecord,
  CatalogTool,
  ExternalA2aAgent,
  IntegrationNotFoundError,
  IntegrationOperationError,
  Workflow,
  WorkflowManifest,
} from 'agentdock-sdk/schemas';
import * as Config from 'effect/Config';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import { AgentCommunicationPolicy, type AgentCommunicationPolicyError } from '../agents/communication-policy';
import { resolveAgentDefinition } from '../agents/runtime-layers';
import { AgentRegistry, type AgentRegistryError } from '../agents/service';
import { IntegrationCatalog } from '../gateway/catalog';
import type { SkillRegistry, SkillRegistryError } from '../skills/service';
import { WorkflowRegistry, type WorkflowRegistryError } from './service';

export type WorkflowDeployment = Extract<GraphDeployment, { readonly kind: 'workflow' }>;

type DeploymentError =
  | AgentRegistryError
  | AgentCommunicationPolicyError
  | WorkflowRegistryError
  | SkillRegistryError
  | IntegrationOperationError
  | IntegrationNotFoundError;
type DeploymentServices =
  | Context.Service.Identifier<typeof AgentRegistry>
  | Context.Service.Identifier<typeof AgentCommunicationPolicy>
  | Context.Service.Identifier<typeof WorkflowRegistry>
  | Context.Service.Identifier<typeof SkillRegistry>
  | Context.Service.Identifier<typeof IntegrationCatalog>;

/**
 * Snapshots everything a workflow run needs to resolve its bindings: the bound
 * agents with their final instructions, and every agent they may delegate to
 * through `send_task` (and those agents' targets in turn), bound external
 * agents, bound workflows (following child workflows' own bindings), and the
 * catalog tools with their schemas.
 */
export const workflowDeploymentFor = (
  workflow: Workflow,
): Effect.Effect<WorkflowDeployment, DeploymentError, DeploymentServices> =>
  Effect.gen(function* () {
    const agentRegistry = yield* AgentRegistry;
    const policy = yield* AgentCommunicationPolicy;
    const workflowRegistry = yield* WorkflowRegistry;
    const catalog = yield* IntegrationCatalog;
    const agents = new Map<string, AgentRecord>();
    const externalAgents = new Map<string, ExternalA2aAgent>();
    const workflows = new Map<string, Workflow>();
    const toolIds = new Set<string>();

    const pinAgent = (agent: AgentRecord): Effect.Effect<void, DeploymentError, DeploymentServices> =>
      Effect.gen(function* () {
        if (agents.has(agent.id)) return;
        const definition = yield* resolveAgentDefinition(agent);
        agents.set(agent.id, { ...agent, instructions: definition.instructions });
        for (const target of yield* policy.listAllowedTargets(agent.id)) yield* pinAgent(target);
      });

    const visit = (current: Workflow): Effect.Effect<void, DeploymentError, DeploymentServices> =>
      Effect.gen(function* () {
        for (const target of Object.values(current.bindings)) {
          if (target.kind === 'agent' && !agents.has(target.id)) {
            const agent = yield* agentRegistry.getById(target.id);
            if (agent) yield* pinAgent(agent);
          } else if (target.kind === 'external' && !externalAgents.has(target.id)) {
            const agent = yield* agentRegistry.getExternalById(target.id);
            if (agent) externalAgents.set(agent.id, agent);
          } else if (target.kind === 'workflow' && !workflows.has(target.id) && target.id !== workflow.id) {
            const child = yield* workflowRegistry.getById(target.id);
            if (child) {
              workflows.set(child.id, child);
              yield* visit(child);
            }
          } else if (target.kind === 'tool') {
            toolIds.add(target.id);
          }
        }
      });

    yield* visit(workflow);
    const tools: ReadonlyArray<CatalogTool> =
      toolIds.size === 0 ? [] : (yield* catalog.listIntegrations()).tools.filter((tool) => toolIds.has(tool.id));
    return {
      kind: 'workflow',
      workflow,
      agents: [...agents.values()],
      externalAgents: [...externalAgents.values()],
      workflows: [...workflows.values()],
      tools,
    };
  });

/** Values for a manifest's declared secrets, read through Config at run time. */
export const workflowSecrets = (manifest: WorkflowManifest): Effect.Effect<Readonly<Record<string, string>>> =>
  Effect.forEach(manifest.secrets ?? [], (name) =>
    Effect.gen(function* () {
      const value = yield* Config.String(name);
      return [name, value] as const;
    }).pipe(Effect.catch(() => Effect.succeed([name, ''] as const))),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
