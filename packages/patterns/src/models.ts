import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessageLike } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { initChatModel } from 'langchain';
import { z } from 'zod';
import { answerMessage, toText } from './core.ts';

const ChatModel = z.custom<BaseChatModel>((value) => value instanceof BaseChatModel);

/**
 * A chat model bound by the host, the model counterpart of `contextAgent`:
 * resolved from `config.context.models[name]` each time a pattern calls it,
 * never when the graph is built. On agentdock that is the platform model the
 * manifest's `models.<name>` binds, so the call runs on the platform's
 * provider keys and is recorded on the calling step; locally pass
 * `{ context: { models: { [name]: new ChatOpenAI(…) } } }` when invoking.
 */
export class ContextModel {
  readonly name: string;
  readonly #bound: z.ZodType<{ readonly models: Readonly<Record<string, BaseChatModel>> }>;

  constructor(name: string) {
    this.name = name;
    this.#bound = z.object({ models: z.object({ [name]: ChatModel }) });
  }

  /** The chat model the host bound under this name for the run `config` belongs to. */
  resolve(config: LangGraphRunnableConfig | undefined): BaseChatModel {
    const bound = this.#bound.safeParse(config?.context);
    const model = bound.success ? bound.data.models[this.name] : undefined;
    if (model === undefined) {
      throw new Error(
        `No chat model '${this.name}' in the runtime context. On agentdock declare it under "models" in ` +
          'agentdock.workflow.json and bind it to a platform model; locally pass ' +
          `{ context: { models: { ${this.name}: new ChatOpenAI(…) } } } when invoking.`,
      );
    }
    return model;
  }
}

/** A chat model bound by the host under `name`, resolved at call time (see {@link ContextModel}). */
export const contextModel = (name: string): ContextModel => new ContextModel(name);

/**
 * A model option of a pattern: a chat model instance, a `provider:model` id
 * resolved with `initChatModel` on first use, or a platform model
 * (`contextModel(name)`) resolved from the run's context on every call.
 */
export type ModelLike = string | BaseChatModel | ContextModel;

/** Resolves a model at call time, so factories stay synchronous and need no API key or context at build time. */
export type ResolveModel = (config: LangGraphRunnableConfig | undefined) => Promise<BaseChatModel>;

export const modelResolver = (model: ModelLike): ResolveModel => {
  if (model instanceof ContextModel) return async (config) => model.resolve(config);
  if (model instanceof BaseChatModel) return async () => model;
  let resolved: Promise<BaseChatModel> | undefined;
  return () => {
    resolved ??= initChatModel(model);
    return resolved;
  };
};

/**
 * How pattern-internal model calls produce structured output (routing, plans,
 * verdicts, answers). `auto` uses the provider's native structured output
 * (`jsonSchema`) when the model's profile declares support, the same rule
 * `createAgent` applies to `responseFormat`, and the provider default (usually
 * forced tool calling) otherwise. Any other value is passed to
 * `withStructuredOutput` as its `method`.
 */
export type StructuredOutputMethod = 'auto' | 'jsonSchema' | 'functionCalling' | 'jsonMode';

/** The `withStructuredOutput` method {@link StructuredOutputMethod} resolves to for `model`. */
const resolveMethod = (model: BaseChatModel, method: StructuredOutputMethod) => {
  if (method !== 'auto') return method;
  return model.profile.structuredOutput === true ? 'jsonSchema' : undefined;
};

/**
 * `model.withStructuredOutput(schema, { name, method })` with the method
 * {@link StructuredOutputMethod} picks. `name` is the function or JSON schema
 * name the model sees. For a platform model, resolve it first:
 * `structuredLlm(contextModel('judge').resolve(config), Verdict, { name: 'Verdict' })`.
 */
export const structuredLlm = <S extends z.ZodType>(
  model: BaseChatModel,
  schema: S,
  options: { readonly name: string; readonly method?: StructuredOutputMethod },
) => {
  const method = resolveMethod(model, options.method ?? 'auto');
  return model.withStructuredOutput(
    schema,
    method === undefined ? { name: options.name } : { name: options.name, method },
  );
};

/** One structured model call, parsed with the schema it was asked for. */
export const structuredCall = async <S extends z.ZodType>(
  model: BaseChatModel,
  schema: S,
  options: { readonly name: string; readonly method?: StructuredOutputMethod },
  messages: BaseMessageLike[],
  config?: LangGraphRunnableConfig,
): Promise<z.output<S>> => schema.parse(await structuredLlm(model, schema, options).invoke(messages, config));

const SchemaTitle = z.object({ title: z.string() });

/** The name a schema gives itself (`.meta({ title })`), else `fallback`. */
export const schemaName = (schema: z.ZodType, fallback: string): string => {
  const meta = SchemaTitle.safeParse(schema.meta());
  return meta.success ? meta.data.title : fallback;
};

/**
 * The final answer of a graph pattern: a plain model call, or a structured one
 * when the pattern has a `responseFormat`.
 */
export const synthesize = async <Answer>(
  model: BaseChatModel,
  responseFormat: z.ZodType<Answer> | undefined,
  method: StructuredOutputMethod,
  messages: BaseMessageLike[],
  config: LangGraphRunnableConfig,
  name: string,
): Promise<{ messages: AIMessage[]; structuredResponse?: Answer }> => {
  if (!responseFormat) {
    const reply = await model.invoke(messages, config);
    return { messages: [answerMessage(reply.text, name)] };
  }
  const value = await structuredCall(
    model,
    responseFormat,
    { name: schemaName(responseFormat, 'FinalAnswer'), method },
    messages,
    config,
  );
  return { messages: [answerMessage(toText(value), name)], structuredResponse: value };
};
