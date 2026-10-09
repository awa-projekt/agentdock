import * as Effect from 'effect/Effect';
import * as Random from 'effect/Random';
import * as Schema from 'effect/Schema';
import { OrgId, UserId } from './identity';
import { ConnectionName, IntegrationToolMode } from './integrations';
import { ReasoningEffort } from './reasoning';
import { SkillId } from './skills';

export const AgentId = Schema.String.pipe(Schema.brand('AgentId'));

export const AgentColor = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.brand('AgentColor'),
);

export const AGENT_COLOR_PALETTE = [
  AgentColor.make('#2563eb'),
  AgentColor.make('#7c3aed'),
  AgentColor.make('#db2777'),
  AgentColor.make('#dc2626'),
  AgentColor.make('#ea580c'),
  AgentColor.make('#ca8a04'),
  AgentColor.make('#16a34a'),
  AgentColor.make('#0891b2'),
] as const satisfies ReadonlyArray<typeof AgentColor.Type>;

export const randomAgentColor: Effect.Effect<typeof AgentColor.Type> = Effect.map(
  Random.nextIntBetween(0, AGENT_COLOR_PALETTE.length),
  (index) => AGENT_COLOR_PALETTE[index] ?? AGENT_COLOR_PALETTE[0],
);

export const AgentCapabilities = Schema.Struct({
  pushNotifications: Schema.Boolean,
  streaming: Schema.Boolean,
});

export const AgentCommunicationToolConfig = Schema.Struct({
  allowAll: Schema.Boolean,
  allowedAgentIds: Schema.Array(AgentId),
});

/** How an enabled integration tool reaches the model: in its own tool set, or only from inside an `executeTs` script. */
export const AgentToolMode = Schema.Literals(['native', 'codemode']);

/**
 * How an assigned skill reaches the model: `inject` puts its full content into
 * the system prompt of every session, `on-demand` lists it by description for
 * the model to load with `load_skill` when a task matches.
 */
export const AgentSkillMode = Schema.Literals(['inject', 'on-demand']);

export const AgentSkills = Schema.Record(SkillId, AgentSkillMode);

/** Grants every tool of the connection the given mode; an explicit tool name overrides it. */
export const ALL_TOOLS = '*';

/**
 * Substituted with this server's own origin when an agent names an endpoint,
 * so a config can reach the instance's own MCP without hardcoding its address.
 */
export const AGENTDOCK_URL_PLACEHOLDER = '${AGENTDOCK_URL}';

export const AgentToolConnection = Schema.Struct({
  owner: Schema.Literals(['org', 'user']),
  name: ConnectionName,
});

/**
 * How the server should connect an integration the agent declares when no
 * connection exists yet. `template` is one of the integration's auth methods;
 * `secrets` maps the method's values to the names of server-side environment
 * variables that hold them, so a config file never carries a credential.
 */
export const AgentIntegrationAuth = Schema.Struct({
  template: Schema.String,
  secrets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/**
 * An integration an agent uses, spelled out completely: the endpoint it is
 * discovered from, how to connect it, which connection the agent's calls go
 * through, and which of its tools the agent gets in which mode. Pushing a
 * config with this block provisions whatever is missing on the server.
 */
export const AgentIntegration = Schema.Struct({
  endpoint: Schema.String,
  auth: Schema.optional(AgentIntegrationAuth),
  connection: AgentToolConnection,
  tools: Schema.Record(Schema.String, AgentToolMode),
});

export const AgentIntegrations = Schema.Record(Schema.String, AgentIntegration);

/**
 * Declares the stable structured-output shape an agent guarantees for its final
 * answer. When set, the agent runs with this schema as its response format and
 * advertises it on its AgentCard via the output-contract extension, so callers
 * know exactly what they are guaranteed to receive back.
 *
 * `schema` holds a serialized JSON Schema (mirroring the workflow input node's
 * `dataSchema`); it is both fed to the model as the response format and embedded
 * verbatim in the AgentCard extension.
 */
export const OutputContract = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  schema: Schema.String,
});

/**
 * Declares the structured input shape an agent expects from A2A callers. The
 * schema is advertised on the AgentCard via the input-contract extension and is
 * used by workflow agent nodes to expose field-level mappings instead of a
 * free-form prompt box.
 */
export const InputContract = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  schema: Schema.String,
});

export const CreateAgentInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  color: Schema.optional(AgentColor),
  integrations: AgentIntegrations,
  skills: AgentSkills,
  communication: AgentCommunicationToolConfig,
  orgId: Schema.optional(OrgId),
  createdByUserId: Schema.optional(UserId),
  instructions: Schema.String,
  model: Schema.String,
  /** Provider-neutral thinking budget; absent leaves the provider default. */
  reasoningEffort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  version: Schema.String,
  capabilities: AgentCapabilities,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
  inputContract: Schema.optional(Schema.NullOr(InputContract)),
  outputContract: Schema.optional(Schema.NullOr(OutputContract)),
});

/**
 * An agent as a file in a local project: the authoring fields of
 * `CreateAgentInput` without platform ownership or credential bookkeeping.
 * `agents/<name>.agent.yaml` in a CLI project holds exactly this.
 */
export const AgentConfig = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  color: Schema.optional(AgentColor),
  instructions: Schema.String,
  model: Schema.String,
  reasoningEffort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  version: Schema.String,
  integrations: AgentIntegrations,
  skills: AgentSkills,
  communication: AgentCommunicationToolConfig,
  capabilities: AgentCapabilities,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
  inputContract: Schema.optional(Schema.NullOr(InputContract)),
  outputContract: Schema.optional(Schema.NullOr(OutputContract)),
});

export const AgentVisibility = Schema.Literals(['public', 'internal', 'external']);

export const AgentRecord = Schema.Struct({
  id: AgentId,
  visibility: AgentVisibility,
  name: Schema.String,
  description: Schema.String,
  color: AgentColor,
  integrations: AgentIntegrations,
  skills: AgentSkills,
  communication: AgentCommunicationToolConfig,
  orgId: Schema.optional(Schema.NullOr(OrgId)),
  createdByUserId: Schema.optional(Schema.NullOr(UserId)),
  instructions: Schema.String,
  model: Schema.String,
  reasoningEffort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  version: Schema.String,
  capabilities: AgentCapabilities,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
  inputContract: Schema.optional(Schema.NullOr(InputContract)),
  outputContract: Schema.optional(Schema.NullOr(OutputContract)),
  /** Bumped on every update; send it back as `expectedRevision` to refuse overwriting a newer version. */
  revision: Schema.Number,
});

export const AgentPath = Schema.Struct({
  agentId: AgentId,
});

export const UpdateAgentInput = Schema.Struct({
  ...CreateAgentInput.fields,
  expectedRevision: Schema.optional(Schema.Number),
});
export const AgentList = Schema.Array(AgentRecord);

export const ExternalA2aAgent = Schema.Struct({
  id: AgentId,
  visibility: Schema.Literal('external'),
  name: Schema.String,
  description: Schema.String,
  endpointUrl: Schema.String,
  version: Schema.String,
  capabilities: AgentCapabilities,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const AddExternalA2aAgentInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  endpointUrl: Schema.String,
  version: Schema.String,
  capabilities: AgentCapabilities,
  defaultInputModes: Schema.Array(Schema.String),
  defaultOutputModes: Schema.Array(Schema.String),
});

export const UpdateExternalA2aAgentInput = AddExternalA2aAgentInput;
export const ExternalA2aAgentList = Schema.Array(ExternalA2aAgent);

export const AgentModelInfo = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  inputCostPerMillion: Schema.optional(Schema.Number),
  outputCostPerMillion: Schema.optional(Schema.Number),
});

export const AgentInternalsTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.Literals(['internal', 'integration']),
  description: Schema.String,
  active: Schema.Boolean,
  mode: Schema.optional(IntegrationToolMode),
});

export const AgentInternalsPrompt = Schema.Struct({
  editableInstructions: Schema.String,
  finalInstructions: Schema.String,
  tokenCount: Schema.Number,
});

export const AgentInternalsResponse = Schema.Struct({
  agentId: AgentId,
  model: AgentModelInfo,
  tools: Schema.Array(AgentInternalsTool),
  prompt: AgentInternalsPrompt,
});

export const RemoveAgentResponse = Schema.Struct({
  removed: Schema.Boolean,
});

export type AgentId = Schema.Schema.Type<typeof AgentId>;
export type AgentColor = Schema.Schema.Type<typeof AgentColor>;
export type AgentCapabilities = Schema.Schema.Type<typeof AgentCapabilities>;
export type AgentCommunicationToolConfig = Schema.Schema.Type<typeof AgentCommunicationToolConfig>;
export type AgentToolMode = Schema.Schema.Type<typeof AgentToolMode>;
export type AgentSkillMode = Schema.Schema.Type<typeof AgentSkillMode>;
export type AgentSkills = Schema.Schema.Type<typeof AgentSkills>;
export type AgentToolConnection = Schema.Schema.Type<typeof AgentToolConnection>;
export type AgentIntegrationAuth = Schema.Schema.Type<typeof AgentIntegrationAuth>;
export type AgentIntegration = Schema.Schema.Type<typeof AgentIntegration>;
export type AgentIntegrations = Schema.Schema.Type<typeof AgentIntegrations>;
export type InputContract = Schema.Schema.Type<typeof InputContract>;
export type OutputContract = Schema.Schema.Type<typeof OutputContract>;
export type AgentVisibility = Schema.Schema.Type<typeof AgentVisibility>;
export type CreateAgentInput = Schema.Schema.Type<typeof CreateAgentInput>;
export type AgentConfig = Schema.Schema.Type<typeof AgentConfig>;
export type UpdateAgentInput = Schema.Schema.Type<typeof UpdateAgentInput>;
export type AgentRecord = Schema.Schema.Type<typeof AgentRecord>;
export type ExternalA2aAgent = Schema.Schema.Type<typeof ExternalA2aAgent>;
export type AddExternalA2aAgentInput = Schema.Schema.Type<typeof AddExternalA2aAgentInput>;
export type UpdateExternalA2aAgentInput = Schema.Schema.Type<typeof UpdateExternalA2aAgentInput>;
export type AgentInternalsResponse = Schema.Schema.Type<typeof AgentInternalsResponse>;
export type RemoveAgentResponse = Schema.Schema.Type<typeof RemoveAgentResponse>;
