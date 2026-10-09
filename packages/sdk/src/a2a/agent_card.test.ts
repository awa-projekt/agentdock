import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { AgentRecord } from '../schemas';
import {
  createAgentCard,
  ENDPOINTS_EXTENSION_URI,
  INPUT_CONTRACT_EXTENSION_URI,
  OUTPUT_CONTRACT_EXTENSION_URI,
} from './agent_card';

const decodeAgent = Schema.decodeUnknownSync(AgentRecord);

const agent = decodeAgent({
  id: 'agent-1',
  visibility: 'public',
  name: 'Support Bot',
  description: 'Answers support questions',
  color: '#2563eb',
  integrations: {},
  skills: {},
  communication: { allowAll: false, allowedAgentIds: [] },
  instructions: 'Be helpful',
  model: 'openai:gpt-5.6-luna',
  version: '1.2.3',
  capabilities: { pushNotifications: false, streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  revision: 1,
});

describe('createAgentCard', () => {
  const url = 'http://localhost:38123/agents/agent-1/a2a';
  const card = createAgentCard({ agent, url });

  it('always advertises the endpoints extension (a2a + ag-ui) even without contracts', () => {
    const extensions = card.capabilities.extensions ?? [];
    expect(extensions.map((ext) => ext.uri)).toContain(ENDPOINTS_EXTENSION_URI);
  });
});

describe('createAgentCard with an output contract', () => {
  const url = 'http://localhost:38123/agents/agent-1/a2a';
  const schema = '{"type":"object","required":["invoiceNumber"],"properties":{"invoiceNumber":{"type":"string"}}}';
  const contractAgent = decodeAgent({
    ...agent,
    outputContract: { name: 'invoiceExtraction', description: 'Returns invoice fields', schema },
  });
  const card = createAgentCard({ agent: contractAgent, url });

  it('advertises the output-contract extension with the parsed schema', () => {
    const extension = card.capabilities.extensions?.find((ext) => ext.uri === OUTPUT_CONTRACT_EXTENSION_URI);
    expect(extension).toBeDefined();
    expect(extension?.required).toBe(true);
    expect(extension?.description).toBe('Returns invoice fields');
    expect(extension?.params?.defaultOutput).toMatchObject({
      name: 'invoiceExtraction',
      mediaType: 'application/json',
      partType: 'data',
      schema: JSON.parse(schema),
    });
  });

  it('adds application/json to the advertised output modes', () => {
    expect(card.defaultOutputModes).toContain('application/json');
  });
});

describe('createAgentCard with an input contract', () => {
  const url = 'http://localhost:38123/agents/agent-1/a2a';
  const schema = '{"type":"object","required":["question"],"properties":{"question":{"type":"string"}}}';
  const contractAgent = decodeAgent({
    ...agent,
    inputContract: { name: 'supportRequest', description: 'Requires a question', schema },
  });
  const card = createAgentCard({ agent: contractAgent, url });

  it('advertises the input-contract extension with the parsed schema', () => {
    const extension = card.capabilities.extensions?.find((ext) => ext.uri === INPUT_CONTRACT_EXTENSION_URI);
    expect(extension).toBeDefined();
    expect(extension?.required).toBe(true);
    expect(extension?.description).toBe('Requires a question');
    expect(extension?.params?.defaultInput).toMatchObject({
      name: 'supportRequest',
      mediaType: 'application/json',
      partType: 'data',
      schema: JSON.parse(schema),
    });
  });

  it('adds application/json to the advertised input modes', () => {
    expect(card.defaultInputModes).toContain('application/json');
  });
});
