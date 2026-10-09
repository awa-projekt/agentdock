import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseLanguageModelInput, StructuredOutputMethodOptions } from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { ModelProfile } from '@langchain/core/language_models/profile';
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  type StandardMessageStructure,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import { type Runnable, RunnableLambda } from '@langchain/core/runnables';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';

/**
 * Test utilities: a scripted, tool-calling chat model and a usage tracker.
 *
 * {@link ScriptedModel} stands in for a real chat model. Instead of replaying
 * a fixed list of answers it calls a policy for every model call; the policy
 * sees a {@link ModelTurn} (messages, bound tools, whether a structured answer
 * is expected) and returns what a real model would. Because the policy is a
 * function of the conversation, parallel branches and subagents stay
 * deterministic whatever order they run in.
 *
 *     const model = scriptedModel((turn) => {
 *       if (!turn.called('get_weather')) return turn.call('get_weather', { city: 'Berlin' });
 *       return turn.say(`It is ${turn.result('get_weather')}`);
 *     });
 *
 * It supports what the patterns rely on: `bindTools` (the policy sees the
 * tools of the call), parallel tool calls, and structured output both through
 * tool calling and natively (`withStructuredOutput(schema, { method:
 * 'jsonSchema' })`, `createAgent`'s provider strategy). Pass `{ profile: {
 * structuredOutput: true } }` to simulate a model with native support;
 * `createAgent` and the patterns then pick the native path, as they do for
 * current Claude and OpenAI models. `turn.structured(...)` answers correctly
 * on both paths.
 */

type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json };

export type ToolArgs = { readonly [key: string]: Json };

/** Raised when a policy does something a real model could not do. */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

const JsonSchemaValue = z.object({
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.json()).optional(),
});

/** The parts of a JSON schema the scripted model reads: required and known properties. */
export type JsonSchemaObject = z.infer<typeof JsonSchemaValue>;

/** A tool as the model sees it: name and JSON schema of its arguments. */
export type BoundTool = { readonly name: string; readonly parameters: JsonSchemaObject };

/** A native structured output request: the JSON schema the answer must follow. */
export type NativeFormat = { readonly name: string; readonly schema: JsonSchemaObject };

const OpenAITool = z.object({ function: z.object({ name: z.string(), parameters: JsonSchemaValue.optional() }) });
const ResponseFormat = z.object({
  json_schema: z.object({ name: z.string().optional(), schema: JsonSchemaValue.optional() }),
});
const ToolChoice = z.union([z.string(), z.boolean(), z.object({}).loose()]);

const toBoundTool = (tool: BindToolsInput): BoundTool => {
  const parsed = OpenAITool.parse(convertToOpenAITool(tool));
  return { name: parsed.function.name, parameters: parsed.function.parameters ?? {} };
};

const callIds = { next: 0 };
const newCallId = (): string => {
  callIds.next += 1;
  return `call_${callIds.next}`;
};

const JsonValue = z.json();

const parseJson = (text: string): Json => {
  try {
    return JsonValue.parse(JSON.parse(text));
  } catch {
    return text;
  }
};

/** Everything the model sees in one call, plus helpers to build its reply. */
export class ModelTurn {
  readonly messages: ReadonlyArray<BaseMessage>;
  readonly tools: ReadonlyArray<BoundTool>;
  /** The forced tool choice, when the call forces one (`any`, `required` or a tool name). */
  readonly toolChoice: string | undefined;
  /** The native structured output request, when the call asks for one. */
  readonly responseFormat: NativeFormat | undefined;

  constructor(fields: {
    readonly messages: ReadonlyArray<BaseMessage>;
    readonly tools: ReadonlyArray<BoundTool>;
    readonly toolChoice: string | undefined;
    readonly responseFormat: NativeFormat | undefined;
  }) {
    this.messages = fields.messages;
    this.tools = fields.tools;
    this.toolChoice = fields.toolChoice;
    this.responseFormat = fields.responseFormat;
  }

  // ------------------------------------------------------------------ reading
  /** The text of all system messages of this call. */
  get system(): string {
    return this.messages
      .filter((message) => SystemMessage.isInstance(message))
      .map((message) => message.text)
      .join('\n');
  }

  get humanMessages(): ReadonlyArray<string> {
    return this.messages.filter((message) => HumanMessage.isInstance(message)).map((message) => message.text);
  }

  get firstHuman(): string {
    return this.humanMessages[0] ?? '';
  }

  get lastHuman(): string {
    return this.humanMessages.at(-1) ?? '';
  }

  /** All human and tool message text, handy for keyword heuristics. */
  get conversationText(): string {
    return this.messages
      .filter((message) => HumanMessage.isInstance(message) || ToolMessage.isInstance(message))
      .map((message) => message.text)
      .join('\n');
  }

  get toolNames(): ReadonlyArray<string> {
    return this.tools.map((tool) => tool.name);
  }

  hasTool(name: string): boolean {
    return this.toolNames.includes(name);
  }

  toolsWithPrefix(prefix: string): ReadonlyArray<string> {
    return this.toolNames.filter((name) => name.startsWith(prefix));
  }

  /** The JSON schema of a bound tool's arguments. */
  toolParameters(name: string): JsonSchemaObject {
    return this.tools.find((tool) => tool.name === name)?.parameters ?? {};
  }

  /** Tool calls the model already made in this conversation, optionally of one tool. */
  toolCallsMade(name?: string): ReadonlyArray<{ readonly id: string; readonly name: string; readonly args: ToolArgs }> {
    return this.messages.flatMap((message) =>
      isAIMessage(message)
        ? (message.tool_calls ?? []).flatMap((call) =>
            name === undefined || call.name === name
              ? [{ id: call.id ?? '', name: call.name, args: ToolArgsValue.parse(call.args) }]
              : [],
          )
        : [],
    );
  }

  /** Whether the model called `name` in this conversation. */
  called(name: string): boolean {
    return this.toolCallsMade(name).length > 0 || this.toolResults(name).length > 0;
  }

  /** Tool results of this conversation, optionally of one tool (matched by the call they answer). */
  toolResults(name?: string): ReadonlyArray<ToolMessage> {
    const ids = new Set(this.toolCallsMade(name).map((call) => call.id));
    return this.messages.flatMap((message) =>
      ToolMessage.isInstance(message) && (name === undefined || ids.has(message.tool_call_id) || message.name === name)
        ? [message]
        : [],
    );
  }

  /** The latest result of a tool, or undefined. */
  result(name: string): string | undefined {
    return this.toolResults(name).at(-1)?.text;
  }

  /** All results of a tool, JSON-decoded where possible. */
  jsonResults(name: string): ReadonlyArray<Json> {
    return this.toolResults(name).map((message) => parseJson(message.text));
  }

  jsonResult(name: string): Json | undefined {
    return this.jsonResults(name).at(-1);
  }

  /** Completed tool calls with their arguments and (JSON-decoded) results. */
  callResults(): ReadonlyArray<{ readonly tool: string; readonly args: ToolArgs; readonly result: Json }> {
    const answers = new Map(
      this.messages.flatMap((message) => (ToolMessage.isInstance(message) ? [[message.tool_call_id, message]] : [])),
    );
    return this.toolCallsMade().flatMap((call) => {
      const answer = answers.get(call.id);
      return answer ? [{ tool: call.name, args: call.args, result: parseJson(answer.text) }] : [];
    });
  }

  /**
   * The JSON schema of the requested structured output: the native response
   * format, or the single bound tool (`withStructuredOutput` via tool calling).
   */
  structuredToolSchema(): JsonSchemaObject | undefined {
    if (this.responseFormat) return this.responseFormat.schema;
    const [only, ...rest] = this.tools;
    return only !== undefined && rest.length === 0 ? only.parameters : undefined;
  }

  // ----------------------------------------------------------------- replying
  /** Reply with plain text (ends an agent loop). */
  say(text: string): AIMessage {
    return new AIMessage(text);
  }

  /** Reply with one tool call. */
  call(name: string, args: ToolArgs = {}): AIMessage {
    return this.callMany([name, args]);
  }

  /** Reply with several (parallel) tool calls. */
  callMany(...calls: ReadonlyArray<readonly [string, ToolArgs]>): AIMessage {
    const unbound = calls.filter(([name]) => !this.hasTool(name)).map(([name]) => name);
    if (unbound.length > 0) {
      throw new ScriptError(
        `Policy tried to call ${unbound.join(', ')}, but only ${this.toolNames.join(', ') || 'no tools'} are bound.`,
      );
    }
    return new AIMessage({
      content: '',
      tool_calls: calls.map(([name, args]) => ({ id: newCallId(), name, args: { ...args }, type: 'tool_call' })),
    });
  }

  /**
   * Reply with structured output: JSON text when native structured output was
   * requested, else a call of the structured output tool, resolved from
   * `toolName`, the only bound tool, or the bound tool whose parameters fit.
   */
  structured(data: ToolArgs, toolName?: string): AIMessage {
    if (toolName !== undefined && this.hasTool(toolName)) return this.call(toolName, data);
    if (this.responseFormat) return new AIMessage(JSON.stringify(data));
    const [only, ...rest] = this.tools;
    const name = only !== undefined && rest.length === 0 ? only.name : this.#toolMatching(data);
    if (name === undefined) throw new ScriptError('Cannot infer the structured output tool; pass toolName.');
    return this.call(name, data);
  }

  #toolMatching(data: ToolArgs): string | undefined {
    const keys = Object.keys(data);
    return this.tools.find((tool) => {
      const required = tool.parameters.required ?? [];
      const properties = Object.keys(tool.parameters.properties ?? {});
      return required.every((key) => keys.includes(key)) && keys.every((key) => properties.includes(key));
    })?.name;
  }
}

const ToolArgsValue = z.record(z.string(), z.json());

/** What the policy returns for one call: a reply message, or plain text. */
export type Policy = (turn: ModelTurn) => AIMessage | string;

export type ScriptedModelOptions = {
  /** Capabilities the model declares; `{ structuredOutput: true }` makes LangChain and the patterns go native. */
  readonly profile?: ModelProfile;
  /** Throw when a call forces a tool (`tool_choice`) but the policy answers with text. Default true. */
  readonly strictToolChoice?: boolean;
};

type ScriptedCallOptions = BaseChatModelCallOptions & {
  readonly tools?: ReadonlyArray<BoundTool>;
  /** The tool the call forces (`any` for any tool), normalized from `tool_choice`. */
  readonly forced_tool?: string;
  readonly native_format?: NativeFormat;
};

const BoundOptions = z.object({
  tool_choice: ToolChoice.optional(),
  response_format: ResponseFormat.optional(),
});

const forcedChoice = (choice: z.infer<typeof ToolChoice> | undefined): string | undefined => {
  if (choice === undefined || choice === false || choice === 'auto' || choice === 'none') return undefined;
  return z.string().safeParse(choice).data ?? 'any';
};

/** The call options of a binding: its tools, the tool it forces, and the native format it requests. */
const bindingOptions = (
  tools: ReadonlyArray<BoundTool>,
  forced: string | undefined,
  format: NativeFormat | undefined,
): Partial<ScriptedCallOptions> => {
  if (forced !== undefined && format !== undefined) return { tools, forced_tool: forced, native_format: format };
  if (forced !== undefined) return { tools, forced_tool: forced };
  if (format !== undefined) return { tools, native_format: format };
  return { tools };
};

/** Rough token estimate (about four characters per token), so patterns can be compared. */
const estimateUsage = (turn: ModelTurn, reply: AIMessage) => {
  const promptChars =
    turn.messages.reduce((sum, message) => sum + message.text.length, 0) +
    JSON.stringify(turn.tools).length +
    (turn.responseFormat ? JSON.stringify(turn.responseFormat).length : 0);
  const outputChars = reply.text.length + JSON.stringify((reply.tool_calls ?? []).map((call) => call.args)).length;
  const input = Math.floor(promptChars / 4) + 1;
  const output = Math.floor(outputChars / 4) + 1;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
};

/** A deterministic chat model driven by a policy (see the module docs). */
export class ScriptedModel extends BaseChatModel<ScriptedCallOptions> {
  /** Every call the policy answered, in order. */
  readonly calls: Array<ModelTurn> = [];
  readonly #policy: Policy;
  readonly #profile: ModelProfile;
  readonly #strictToolChoice: boolean;

  constructor(policy: Policy, options: ScriptedModelOptions = {}) {
    super({});
    this.#policy = policy;
    this.#profile = options.profile ?? {};
    this.#strictToolChoice = options.strictToolChoice ?? true;
    // SAFETY: `structuredOutput` implements the overloads `withStructuredOutput` declares for the Zod
    // schemas this model is used with; a class method cannot restate them without `Record<string, any>`.
    this.withStructuredOutput = this.#structuredOutput as BaseChatModel['withStructuredOutput'];
  }

  _llmType(): string {
    return 'scripted';
  }

  override get profile(): ModelProfile {
    return this.#profile;
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<ScriptedCallOptions>) {
    const bound = BoundOptions.parse(kwargs ?? {});
    const format = bound.response_format;
    const native =
      format === undefined
        ? undefined
        : { name: format.json_schema.name ?? 'response', schema: format.json_schema.schema ?? {} };
    return this.withConfig(bindingOptions(tools.map(toBoundTool), forcedChoice(bound.tool_choice), native));
  }

  #structuredOutput = <Output>(
    schema: z.ZodType<Output>,
    config?: StructuredOutputMethodOptions<boolean>,
  ): Runnable<BaseLanguageModelInput, Output> => {
    if (config?.includeRaw) throw new ScriptError('The scripted model does not support includeRaw.');
    const name = config?.name ?? 'extract';
    const parameters = JsonSchemaValue.parse(toJsonSchema(schema));
    if (config?.method === 'jsonSchema') {
      return this.withConfig(bindingOptions([], undefined, { name, schema: parameters })).pipe(
        RunnableLambda.from((reply: AIMessageChunk) => schema.parse(JSON.parse(reply.text))),
      );
    }
    if (config?.method === 'jsonMode') throw new ScriptError('The scripted model does not support jsonMode.');
    return this.withConfig(bindingOptions([{ name, parameters }], name, undefined)).pipe(
      RunnableLambda.from((reply: AIMessageChunk) => {
        const call = (reply.tool_calls ?? []).find((candidate) => candidate.name === name);
        if (!call) throw new ScriptError(`The reply calls no '${name}' tool.`);
        return schema.parse(call.args);
      }),
    );
  };

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const turn = new ModelTurn({
      messages,
      tools: options.tools ?? [],
      toolChoice: options.forced_tool,
      responseFormat: options.native_format,
    });
    this.calls.push(turn);
    const output = this.#policy(turn);
    const reply = AIMessage.isInstance(output) ? output : new AIMessage(output);
    const calls = reply.tool_calls ?? [];
    if (this.#strictToolChoice && turn.toolChoice !== undefined && turn.tools.length > 0 && calls.length === 0) {
      throw new ScriptError(
        `tool_choice forces a tool call, but the policy answered with text. Bound tools: ${turn.toolNames.join(', ')}`,
      );
    }
    const message = new AIMessage<StandardMessageStructure>({
      content: reply.text,
      tool_calls: calls,
      usage_metadata: estimateUsage(turn, reply),
      response_metadata: { model_name: 'scripted' },
    });
    return { generations: [{ text: message.text, message }] };
  }
}

/** A {@link ScriptedModel} driven by `policy`. */
export const scriptedModel = (policy: Policy, options: ScriptedModelOptions = {}): ScriptedModel =>
  new ScriptedModel(policy, options);

const RunMetadata = z.object({ lc_agent_name: z.string().optional(), langgraph_node: z.string().optional() });
const Usage = z.object({ input_tokens: z.number(), output_tokens: z.number() });
const Generated = z.object({ message: z.object({ usage_metadata: Usage.optional() }).optional() });

type ChatModelStartArgs = Parameters<NonNullable<BaseCallbackHandler['handleChatModelStart']>>;
type ToolStartArgs = Parameters<NonNullable<BaseCallbackHandler['handleToolStart']>>;

/**
 * Callback counting the model calls, tokens and tool calls of a run, model
 * calls per agent included. Works with real models too (it reads
 * `usage_metadata`). Pass it as `{ callbacks: [tracker] }`; callbacks reach
 * subgraphs and subagents invoked from tools.
 */
export class UsageTracker extends BaseCallbackHandler {
  name = 'UsageTracker';
  override awaitHandlers = true;
  modelCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  readonly toolCalls = new Map<string, number>();
  readonly modelCallsByAgent = new Map<string, number>();

  override handleChatModelStart(...args: ChatModelStartArgs): void {
    const metadata = RunMetadata.safeParse(args[6] ?? {});
    const agent = (metadata.success && (metadata.data.lc_agent_name ?? metadata.data.langgraph_node)) || '?';
    this.modelCalls += 1;
    this.modelCallsByAgent.set(agent, (this.modelCallsByAgent.get(agent) ?? 0) + 1);
  }

  override handleLLMEnd(output: LLMResult): void {
    for (const generation of output.generations.flat()) {
      const usage = Generated.safeParse(generation).data?.message?.usage_metadata;
      this.inputTokens += usage?.input_tokens ?? 0;
      this.outputTokens += usage?.output_tokens ?? 0;
    }
  }

  override handleToolStart(...args: ToolStartArgs): void {
    const name = args[6] ?? args[0].id.at(-1) ?? '?';
    this.toolCalls.set(name, (this.toolCalls.get(name) ?? 0) + 1);
  }

  summary() {
    return {
      modelCalls: this.modelCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      toolCalls: [...this.toolCalls.values()].reduce((sum, count) => sum + count, 0),
      tools: Object.fromEntries(this.toolCalls),
      modelCallsByAgent: Object.fromEntries(this.modelCallsByAgent),
    };
  }
}
