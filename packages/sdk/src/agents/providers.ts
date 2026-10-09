import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatMistralAI } from '@langchain/mistralai';
import type { ChatOpenAIFields, ClientOptions } from '@langchain/openai';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import { ChatXAI } from '@langchain/xai';
import type { ReasoningEffort } from '../schemas/reasoning';
import type { ContentFormat } from './content';

type AnthropicFields = NonNullable<ConstructorParameters<typeof ChatAnthropic>[0]>;
type GoogleFields = NonNullable<ConstructorParameters<typeof ChatGoogleGenerativeAI>[0]>;
type AzureFields = NonNullable<ConstructorParameters<typeof AzureChatOpenAI>[0]>;

/**
 * OpenAI reasoning options: always ask the Responses API for reasoning
 * summaries so the chat can show what the model thought between tool calls,
 * plus the configured effort. LangChain only forwards this block to reasoning
 * models (o-series, gpt-5*), so it is harmless elsewhere.
 */
const openaiReasoning = (effort: ReasoningEffort | undefined): NonNullable<ChatOpenAIFields['reasoning']> => {
  const reasoning: NonNullable<ChatOpenAIFields['reasoning']> = { summary: 'auto' };
  // OpenAI has no `max` tier and models.dev never lists it for OpenAI models.
  if (effort !== undefined && effort !== 'max') reasoning.effort = effort;
  return reasoning;
};

/**
 * Claude takes the tier as an output effort with adaptive thinking; `none`
 * turns thinking off. models.dev only lists effort tiers for models that
 * accept them, so no per-generation special casing is needed here.
 */
const applyAnthropicReasoning = (fields: AnthropicFields, effort: ReasoningEffort | undefined): void => {
  if (effort === undefined) return;
  if (effort === 'none' || effort === 'minimal') {
    fields.thinking = { type: 'disabled' };
    return;
  }
  fields.thinking = { type: 'adaptive' };
  fields.outputConfig = { effort };
};

/** Gemini takes a named thinking level; thoughts are always requested so the chat can show them. */
const applyGoogleReasoning = (fields: GoogleFields, effort: ReasoningEffort | undefined): void => {
  if (effort === undefined) return;
  const level =
    effort === 'none' || effort === 'minimal' || effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH';
  fields.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
};

export type SupportedLlmProvider = {
  readonly id: string;
  readonly name: string;
  readonly envVar: string;
  readonly create: (
    modelId: string,
    apiKey: string | undefined,
    reasoningEffort: ReasoningEffort | undefined,
  ) => BaseChatModel;
};

export const SUPPORTED_LLM_PROVIDERS: ReadonlyArray<SupportedLlmProvider> = [
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    create: (model, apiKey, effort) => {
      const fields: ChatOpenAIFields = { model, useResponsesApi: true, reasoning: openaiReasoning(effort) };
      if (apiKey !== undefined) fields.apiKey = apiKey;
      return new ChatOpenAI(fields);
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    create: (model, apiKey, effort) => {
      const fields: AnthropicFields = { model };
      if (apiKey !== undefined) fields.apiKey = apiKey;
      applyAnthropicReasoning(fields, effort);
      return new ChatAnthropic(fields);
    },
  },
  {
    id: 'google_genai',
    name: 'Google',
    envVar: 'GOOGLE_API_KEY',
    create: (model, apiKey, effort) => {
      const fields: GoogleFields = { model };
      if (apiKey !== undefined) fields.apiKey = apiKey;
      applyGoogleReasoning(fields, effort);
      return new ChatGoogleGenerativeAI(fields);
    },
  },
  {
    id: 'xai',
    name: 'xAI',
    envVar: 'XAI_API_KEY',
    create: (model, apiKey) => (apiKey === undefined ? new ChatXAI({ model }) : new ChatXAI({ model, apiKey })),
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    create: (model, apiKey) =>
      apiKey === undefined ? new ChatMistralAI({ model }) : new ChatMistralAI({ model, apiKey }),
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    create: (model, apiKey) =>
      apiKey === undefined ? new ChatDeepSeek({ model }) : new ChatDeepSeek({ model, apiKey }),
  },
  {
    id: 'groq',
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    create: (model, apiKey) => (apiKey === undefined ? new ChatGroq({ model }) : new ChatGroq({ model, apiKey })),
  },
];

const PROVIDER_BY_ID = new Map(SUPPORTED_LLM_PROVIDERS.map((provider) => [provider.id, provider]));

export type CustomProviderKind = 'openai-compatible' | 'azure-openai';

export type ModelRuntimeConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly queryParams?: Record<string, string>;
  readonly kind?: CustomProviderKind;

  readonly chatModel?: BaseChatModel;
};

export const createChatModel = (
  provider: string,
  modelId: string,
  config?: ModelRuntimeConfig,
  reasoningEffort?: ReasoningEffort,
): BaseChatModel => {
  const supported = PROVIDER_BY_ID.get(provider);
  if (supported) {
    return supported.create(modelId, config?.apiKey, reasoningEffort);
  }

  if (config?.kind === 'azure-openai' && config.baseUrl) {
    const azure: AzureFields = {
      model: modelId,
      azureOpenAIApiDeploymentName: modelId,
      azureOpenAIEndpoint: config.baseUrl,
      useResponsesApi: true,
      reasoning: openaiReasoning(reasoningEffort),
    };
    if (config.apiKey) azure.azureOpenAIApiKey = config.apiKey;
    const apiVersion = config.queryParams?.['api-version'];
    if (apiVersion) azure.azureOpenAIApiVersion = apiVersion;
    return new AzureChatOpenAI(azure);
  }

  if (config?.baseUrl) {
    const configuration: ClientOptions = { baseURL: config.baseUrl };
    if (config.queryParams) configuration.defaultQuery = config.queryParams;
    const openai: ChatOpenAIFields = { model: modelId, configuration };
    if (config.apiKey) openai.apiKey = config.apiKey;
    if (reasoningEffort !== undefined) openai.reasoning = openaiReasoning(reasoningEffort);
    return new ChatOpenAI(openai);
  }

  throw new Error(
    `Model provider '${provider}' is not supported. Use a built-in provider (${[...PROVIDER_BY_ID.keys()].join(', ')}) or a custom provider with a base URL.`,
  );
};

/**
 * Which API format a provider's chat model speaks, so message parts can be
 * rendered the way that API takes them. A model of no known provider (a test
 * fake, a host's own class) keeps LangChain's standard blocks.
 */
export const contentFormatOf = (provider: string, config?: ModelRuntimeConfig): ContentFormat => {
  switch (provider) {
    case 'openai':
      return 'openai-responses';
    case 'anthropic':
      return 'anthropic';
    case 'google_genai':
      return 'google';
    case 'mistral':
      return 'mistral';
    case 'xai':
    case 'deepseek':
    case 'groq':
      return 'openai-chat';
  }
  if (config?.kind === 'azure-openai' && config.baseUrl) return 'openai-responses';
  return config?.baseUrl ? 'openai-chat' : 'standard';
};
