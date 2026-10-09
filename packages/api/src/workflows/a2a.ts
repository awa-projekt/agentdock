import type { AgentCard } from '@a2a-js/sdk';
import { type A2ARequestHandler, DefaultRequestHandler } from '@a2a-js/sdk/server';
import { AgentLoopFactory, AgentRunStore, AgentToolResolver, ModelProvider, randomUUIDv4 } from 'agentdock-sdk';
import type { IntegrationNotFoundError, IntegrationOperationError, Workflow } from 'agentdock-sdk/schemas';
import { WorkflowRunEventId, workflowInputContract } from 'agentdock-sdk/schemas';
import {
  hostRunner,
  inputContractMediaTypes,
  parseInputContractSchema,
  resolveDeploymentBindings,
  WorkflowRunStore,
  WorkflowToolInvoker,
} from 'agentdock-sdk/workflows';
import { Database } from 'db';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import { AgentCommunicationPolicy, type AgentCommunicationPolicyError } from '../agents/communication-policy';
import { AgentRegistry, type AgentRegistryError } from '../agents/service';
import { IntegrationCatalog } from '../gateway/catalog';
import { normalizeBaseUrl } from '../routes';
import { GraphRuntime } from '../runtime/service';
import { SessionsService } from '../sessions/service';
import type { SkillRegistry, SkillRegistryError } from '../skills/service';
import { workflowDeploymentFor, workflowSecrets } from './deployment';
import { WorkflowTaskExecutor } from './executor';
import { DrizzleLibsqlCheckpointSaver } from './langgraph-checkpointer';
import { WorkflowRegistry, type WorkflowRegistryError } from './service';

export type WorkflowA2aHandlerError =
  | AgentRegistryError
  | AgentCommunicationPolicyError
  | SkillRegistryError
  | WorkflowRegistryError
  | IntegrationOperationError
  | IntegrationNotFoundError;

type WorkflowA2aHandlersService = {
  // Building the deployment folds skills into bound agents' instructions via
  // `resolveAgentDefinition`, so `SkillRegistry` is a genuine per-call
  // requirement satisfied by the route that calls `get()`.
  readonly get: (
    workflow: Workflow,
    baseUrl: string,
  ) => Effect.Effect<A2ARequestHandler, WorkflowA2aHandlerError, Context.Service.Identifier<typeof SkillRegistry>>;
};

export const WorkflowA2aHandlers = Context.Service<WorkflowA2aHandlersService>('@agentdock/api/WorkflowA2aHandlers');

const workflowTargetId = (workflowId: string): string => `workflow:${workflowId}`;

const workflowA2aUrl = (baseUrl: string, workflowId: string): string =>
  `${normalizeBaseUrl(baseUrl)}/workflows/${workflowId}/a2a`;

const INPUT_CONTRACT_EXTENSION_URI = 'urn:agentdock:ext:input-contract:v1';

const createWorkflowCard = (workflow: Workflow, baseUrl: string): AgentCard => {
  const url = workflowA2aUrl(baseUrl, workflow.id);
  const { manifest } = workflow;
  const inputContract = workflowInputContract(workflow);
  const inputModes = [...inputContractMediaTypes(inputContract)];
  const inputContractExtension = inputContract
    ? [
        {
          uri: INPUT_CONTRACT_EXTENSION_URI,
          description: inputContract.description ?? 'Declares the structured input contract for this workflow.',
          required: true,
          params: {
            defaultInput: {
              name: inputContract.name,
              mediaType: inputModes[0] ?? 'application/json',
              partType: inputModes[0] === 'text/plain' ? 'text' : 'data',
              schema: parseInputContractSchema(inputContract) ?? inputContract.schema,
            },
          },
        },
      ]
    : undefined;

  return {
    name: manifest.name,
    description: manifest.description,
    protocolVersion: '0.3.0',
    version: manifest.version,
    url,
    skills: [
      {
        id: 'workflow',
        name: 'Workflow',
        description: manifest.description,
        tags: ['workflow'],
      },
    ],
    capabilities: {
      pushNotifications: false,
      streaming: true,
      extensions: [
        ...(inputContractExtension ?? []),
        {
          uri: 'urn:agentdock:ext:endpoints:v1',
          description: 'Protocol endpoints for this graph.',
          required: false,
          params: { a2a: url, agUi: url.replace(/\/a2a$/, '/ag-ui') },
        },
      ],
    },
    defaultInputModes: inputModes,
    defaultOutputModes: ['text/plain'],
    additionalInterfaces: [
      {
        url,
        transport: 'JSONRPC',
      },
    ],
  };
};

export const WorkflowA2aHandlersLive = Layer.effect(
  WorkflowA2aHandlers,
  Effect.gen(function* () {
    const sessions = yield* SessionsService;
    const graphRuntime = yield* GraphRuntime;
    const agentRegistry = yield* AgentRegistry;
    const communicationPolicy = yield* AgentCommunicationPolicy;
    const workflowRegistry = yield* WorkflowRegistry;
    const workflowRunStore = yield* WorkflowRunStore;
    const catalog = yield* IntegrationCatalog;
    const toolInvoker = yield* WorkflowToolInvoker;
    const database = yield* Database;
    // Host-wired agent-runtime services (`RuntimeHostLayer`, provided by
    // `packages/api/src/handlers.ts`) — the same instances `AgentA2aHandlers`
    // uses for direct a2a calls, so a bound agent invoked inside a workflow
    // behaves identically (model resolution, tool resolution, durable run
    // persistence) to calling that agent standalone.
    const modelProvider = yield* ModelProvider;
    const toolResolver = yield* AgentToolResolver;
    const loopFactory = yield* AgentLoopFactory;
    const agentRunStore = yield* AgentRunStore;
    const httpClient = yield* HttpClient.HttpClient;
    const host = yield* hostRunner();

    graphRuntime.register(
      'workflow',
      async (deployment, recover, lease) => {
        if (deployment.kind !== 'workflow') throw new Error('Expected workflow deployment.');
        const workflow = deployment.workflow;
        const bindings = resolveDeploymentBindings(workflow, deployment);
        const secrets = await host.runPromise(workflowSecrets(workflow.manifest));
        const servicesLayer = Layer.mergeAll(
          Layer.succeed(WorkflowRunStore, workflowRunStore),
          Layer.succeed(AgentLoopFactory, loopFactory),
          Layer.succeed(ModelProvider, modelProvider),
          Layer.succeed(AgentToolResolver, toolResolver),
          Layer.succeed(AgentRunStore, agentRunStore),
          Layer.succeed(WorkflowToolInvoker, toolInvoker),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        );
        return new WorkflowTaskExecutor(workflow, bindings, {
          deployment,
          checkpointer: new DrizzleLibsqlCheckpointSaver(database.db, lease),
          secrets,
          recover,
          run: (effect) => host.runPromise(Effect.provide(effect, servicesLayer)),
        });
      },
      async (deployment, task) => {
        if (deployment.kind !== 'workflow') return;
        const store = await host.runPromise(sessions.getTaskStore(workflowTargetId(deployment.workflow.id)));
        await store.save(task);
        if (task.status.state === 'canceled') {
          await host.runPromise(
            Effect.gen(function* () {
              const runs = yield* workflowRunStore.list();
              const run = runs.find((run) => run.workflowId === deployment.workflow.id && run.taskId === task.id);
              if (run && run.status !== 'canceled')
                yield* workflowRunStore.append({
                  id: WorkflowRunEventId.make(yield* randomUUIDv4),
                  runId: run.id,
                  workflowId: run.workflowId,
                  taskId: task.id,
                  timestamp: DateTime.formatIso(yield* DateTime.now),
                  type: 'run-canceled',
                });
            }),
          );
        }
      },
    );
    return WorkflowA2aHandlers.of({
      get: Effect.fn('WorkflowA2aHandlers.get')(function* (workflow, baseUrl) {
        const taskStore = yield* sessions.getTaskStore(workflowTargetId(workflow.id));
        const deployment = yield* workflowDeploymentFor(workflow).pipe(
          Effect.provideService(AgentRegistry, agentRegistry),
          Effect.provideService(AgentCommunicationPolicy, communicationPolicy),
          Effect.provideService(WorkflowRegistry, workflowRegistry),
          Effect.provideService(IntegrationCatalog, catalog),
        );
        return new DefaultRequestHandler(
          createWorkflowCard(workflow, baseUrl),
          taskStore,
          graphRuntime.executor(deployment),
        );
      }),
    });
  }),
);
