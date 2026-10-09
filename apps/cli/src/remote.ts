import {
  AgentList,
  AgentRecord,
  AgentToolsResponse,
  CreateAgentInput,
  IntegrationsResponse,
  OAuthSessionView,
  RegisteredWorkflow,
  RegisterWorkflowInput,
  UpdateAgentInput,
  WorkflowArtifactDownload,
  WorkflowList,
  WorkflowRunEventList,
  WorkflowRunList,
  WorkflowRunSnapshot,
} from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Api } from './api';
import { cliError } from './errors';
import { slugify } from './project';

const CLIENT_ID = 'agentdock-cli';

export const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});

export const DeviceToken = Schema.Union([
  Schema.Struct({ access_token: Schema.String }),
  Schema.Struct({ error: Schema.String }),
]);

export const Session = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({
      email: Schema.String,
      name: Schema.String,
      role: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);
export type Session = Schema.Schema.Type<typeof Session>;

const encodeCreateAgent = Schema.encodeSync(CreateAgentInput);
const encodeUpdateAgent = Schema.encodeSync(UpdateAgentInput);
const encodeRegisterWorkflow = Schema.encodeSync(RegisterWorkflowInput);

export const listAgents = Api.use((api) => api.call(AgentList, 'GET', 'agents'));

export const createAgent = (input: CreateAgentInput) =>
  Api.use((api) => api.call(AgentRecord, 'POST', 'agents', { body: encodeCreateAgent(input) }));

export const updateAgent = (agentId: string, input: UpdateAgentInput) =>
  Api.use((api) =>
    api.call(AgentRecord, 'PUT', `agents/${encodeURIComponent(agentId)}`, { body: encodeUpdateAgent(input) }),
  );

export const listAgentTools = (agentId: string) =>
  Api.use((api) => api.call(AgentToolsResponse, 'GET', `agents/${encodeURIComponent(agentId)}/tools`));

export const startOrgOAuth = (slug: string) =>
  Api.use((api) =>
    api.call(OAuthSessionView, 'POST', `integrations/${encodeURIComponent(slug)}/connections/oauth`, { body: {} }),
  );

export const listWorkflows = Api.use((api) => api.call(WorkflowList, 'GET', 'workflows'));

export const registerWorkflow = (input: RegisterWorkflowInput) =>
  Api.use((api) => api.call(RegisteredWorkflow, 'POST', 'workflows', { body: encodeRegisterWorkflow(input) }));

export const downloadWorkflowArtifact = (workflowId: string) =>
  Api.use((api) => api.call(WorkflowArtifactDownload, 'GET', `workflows/${encodeURIComponent(workflowId)}/artifact`));

/** Resolves a workflow by id, folder slug or manifest name; ambiguity is an error rather than a guess. */
export const findRemoteWorkflow = (ref: string) =>
  Effect.gen(function* () {
    const workflows = yield* listWorkflows;
    const byId = workflows.find((workflow) => workflow.id === ref);
    if (byId) return byId;
    const matches = workflows.filter(
      (workflow) => workflow.manifest.name === ref || slugify(workflow.manifest.name) === ref,
    );
    const [single, ...rest] = matches;
    if (single === undefined) {
      return yield* cliError(`No registered workflow matches '${ref}'. See 'agentdock workflows'.`);
    }
    if (rest.length === 0) return single;
    return yield* cliError(
      `'${ref}' matches several workflows: ${matches.map((workflow) => workflow.id).join(', ')}. Use an id.`,
    );
  });

export const listWorkflowRuns = Api.use((api) => api.call(WorkflowRunList, 'GET', 'workflows/runs'));

export const listIntegrations = Api.use((api) => api.call(IntegrationsResponse, 'GET', 'integrations'));

export const getWorkflowRun = (runId: string) =>
  Api.use((api) => api.call(WorkflowRunSnapshot, 'GET', `workflows/runs/${encodeURIComponent(runId)}`));

export const listWorkflowRunEvents = (runId: string) =>
  Api.use((api) => api.call(WorkflowRunEventList, 'GET', `workflows/runs/${encodeURIComponent(runId)}/events`));

export const requestDeviceCode = Api.use((api) =>
  api.call(DeviceCode, 'POST', 'api/auth/device/code', { body: { client_id: CLIENT_ID } }),
);

export const requestDeviceToken = (deviceCode: string) =>
  Api.use((api) =>
    api.call(DeviceToken, 'POST', 'api/auth/device/token', {
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: CLIENT_ID,
      },
      decodeErrorStatus: true,
    }),
  );

export const getSession = Api.use((api) =>
  api
    .call(Session, 'GET', 'api/auth/get-session')
    .pipe(Effect.catchTag('ApiError', (error) => (error.status === 401 ? Effect.succeed(null) : Effect.fail(error)))),
);

export const describeSession = (session: Session): string =>
  session === null
    ? 'not logged in'
    : `${session.user.name} <${session.user.email}>${session.user.role ? ` (${session.user.role})` : ''}`;
