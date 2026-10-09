import type { AgentCard, AgentExtension } from '@a2a-js/sdk';
import * as Option from 'effect/Option';
import type { AgentRecord, InputContract, Json, OutputContract } from '../schemas';
import { decodeJsonStringOption } from '../schemas';
import { inputContractMediaTypes } from '../workflows/task-input';

type CreateAgentCardOptions = {
  readonly agent: AgentRecord;
  readonly url: string;
};

/**
 * Identifies the output-contract extension on the AgentCard. Placeholder URI:
 * swap for the canonical company URI when one is chosen (single source of truth).
 */
export const OUTPUT_CONTRACT_EXTENSION_URI = 'urn:agentdock:ext:output-contract:v1';
export const INPUT_CONTRACT_EXTENSION_URI = 'urn:agentdock:ext:input-contract:v1';
export const ENDPOINTS_EXTENSION_URI = 'urn:agentdock:ext:endpoints:v1';

const JSON_MEDIA_TYPE = 'application/json';

// Persisted schema is validated as JSON on save; fall back to the raw string
// rather than dropping the contract if it is somehow unparseable.
const parseContractSchema = (schemaText: string): Json =>
  Option.getOrElse(decodeJsonStringOption(schemaText), () => schemaText);

const inputContractExtension = (contract: InputContract): AgentExtension => ({
  uri: INPUT_CONTRACT_EXTENSION_URI,
  description: contract.description ?? 'Declares the default structured input contract for this agent.',
  required: true,
  params: {
    defaultInput: {
      name: contract.name,
      mediaType: inputContractMediaTypes(contract)[0] ?? JSON_MEDIA_TYPE,
      partType: inputContractMediaTypes(contract)[0] === 'text/plain' ? 'text' : 'data',
      schema: parseContractSchema(contract.schema),
    },
  },
});

/**
 * Builds the optional output-contract extension from an agent's contract.
 * Returns `undefined` when the agent declares no contract, so the extension is
 * only present on cards for agents that guarantee a structured output shape.
 */
const outputContractExtension = (contract: OutputContract): AgentExtension => {
  return {
    uri: OUTPUT_CONTRACT_EXTENSION_URI,
    description: contract.description ?? 'Declares the default structured output contract for this agent.',
    required: true,
    params: {
      defaultOutput: {
        name: contract.name,
        mediaType: JSON_MEDIA_TYPE,
        partType: 'data',
        schema: parseContractSchema(contract.schema),
      },
    },
  };
};

export const createAgentCard = ({ agent, url }: CreateAgentCardOptions): AgentCard => {
  const inputContract = agent.inputContract ?? undefined;
  const contract = agent.outputContract ?? undefined;
  // The card `url` is the A2A endpoint; AG-UI lives beside it.
  const agUiUrl = url.replace(/\/a2a$/, '/ag-ui');
  const extensions = [
    ...(inputContract ? [inputContractExtension(inputContract)] : []),
    ...(contract ? [outputContractExtension(contract)] : []),
    {
      uri: ENDPOINTS_EXTENSION_URI,
      description: 'Declares the protocol endpoints this agent exposes.',
      required: false,
      params: { a2a: url, agUi: agUiUrl },
    },
  ];
  const defaultInputModes = inputContract
    ? [...new Set([...agent.defaultInputModes, ...inputContractMediaTypes(inputContract)])]
    : [...agent.defaultInputModes];
  const defaultOutputModes =
    contract && !agent.defaultOutputModes.includes(JSON_MEDIA_TYPE)
      ? [...agent.defaultOutputModes, JSON_MEDIA_TYPE]
      : [...agent.defaultOutputModes];

  return {
    name: agent.name,
    description: agent.description,
    protocolVersion: '0.3.0',
    version: agent.version,
    url,
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: agent.description,
        tags: Object.keys(agent.integrations),
      },
    ],
    capabilities: extensions.length > 0 ? { ...agent.capabilities, extensions } : { ...agent.capabilities },
    defaultInputModes,
    defaultOutputModes,
    additionalInterfaces: [
      {
        url,
        transport: 'JSONRPC',
      },
    ],
  };
};
