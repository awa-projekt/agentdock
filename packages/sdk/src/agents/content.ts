import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  type BaseMessage,
  type BaseMessageFields,
  HumanMessage,
  type MessageContent,
  ToolMessage,
  type ToolMessageFields,
} from '@langchain/core/messages';
import { isGraphInterrupt } from '@langchain/langgraph';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import { createMiddleware, ToolInvocationError } from 'langchain';
import type { AgentRunPart } from '../schemas/agent-runs';
import { coerceJson, type Json, type JsonObject, type JsonObjectDraft } from '../schemas/json';
import { isToolRunFailure } from '../tools/types';

/**
 * Message parts beyond text: what tools return (MCP content blocks) and what
 * callers send (A2A file and data parts), carried through the agent as
 * LangChain's provider-neutral standard content blocks and rendered for the
 * model's provider just before each call.
 *
 * Agent state, checkpoints and run records keep the neutral blocks; only the
 * request a provider receives is rewritten. Providers differ in what they take
 * where: OpenAI's Responses API and Anthropic accept images inside tool
 * results, Chat Completions, Mistral and Gemini do not, so their tool results
 * keep the text and the media follow in a user message right after.
 */

const MediaKind = Schema.Literals(['image', 'audio', 'video', 'file']);
type MediaKind = typeof MediaKind.Type;

const MediaMetadata = Schema.Struct({ filename: Schema.optional(Schema.String) });

const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String });

/** Bytes inline, base64: LangChain's standard media block, and MCP's `image`/`audio` blocks. */
const InlineMedia = Schema.Struct({
  type: MediaKind,
  data: Schema.String,
  mimeType: Schema.String,
  metadata: Schema.optional(MediaMetadata),
});

const LinkedMedia = Schema.Struct({
  type: MediaKind,
  url: Schema.String,
  mimeType: Schema.optional(Schema.String),
  metadata: Schema.optional(MediaMetadata),
});

const McpResourceLink = Schema.Struct({
  type: Schema.Literal('resource_link'),
  uri: Schema.String,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
});

const McpEmbeddedResource = Schema.Struct({
  type: Schema.Literal('resource'),
  resource: Schema.Union([
    Schema.Struct({ uri: Schema.String, mimeType: Schema.optional(Schema.String), text: Schema.String }),
    Schema.Struct({ uri: Schema.String, mimeType: Schema.optional(Schema.String), blob: Schema.String }),
  ]),
});

/** What workflow code or older LangChain messages put in a human message. */
const ImageUrlBlock = Schema.Struct({
  type: Schema.Literal('image_url'),
  image_url: Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })]),
});

const PlainTextBlock = Schema.Struct({ type: Schema.Literal('text-plain'), text: Schema.String });

const IncomingBlock = Schema.Union([
  TextBlock,
  InlineMedia,
  LinkedMedia,
  McpResourceLink,
  McpEmbeddedResource,
  ImageUrlBlock,
  PlainTextBlock,
]);

const decodeIncomingBlocks = Schema.decodeUnknownOption(Schema.NonEmptyArray(IncomingBlock));

type InlineMedia = typeof InlineMedia.Type;
type LinkedMedia = typeof LinkedMedia.Type;
type MediaBlock = InlineMedia | LinkedMedia;

/** A part of a message as the agent carries it: text, or media inline or behind a URL. */
export type AgentContentBlock = typeof TextBlock.Type | MediaBlock;

const isInline = (block: MediaBlock): block is InlineMedia => 'data' in block;

const mediaKindOf = (mimeType: string): MediaKind => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
};

const basename = (uri: string): string | undefined => {
  const last = uri.split(/[/?#]/).filter((segment) => segment.length > 0);
  return last.at(-1);
};

const DATA_URL = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s;

const parseDataUrl = (url: string): Option.Option<{ readonly mimeType: string; readonly data: string }> => {
  const match = DATA_URL.exec(url);
  if (match === null) return Option.none();
  return Option.some({ mimeType: match[1] ?? 'application/octet-stream', data: match[2] ?? '' });
};

const inlineMedia = (type: MediaKind, data: string, mimeType: string, filename: string | undefined): InlineMedia =>
  filename === undefined ? { type, data, mimeType } : { type, data, mimeType, metadata: { filename } };

const normalizeBlock = (block: typeof IncomingBlock.Type): AgentContentBlock => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'text-plain':
      return { type: 'text', text: block.text };
    case 'resource_link': {
      const label = block.title ?? block.name ?? block.uri;
      const details = [block.mimeType, block.description].filter(Predicate.isString).join(', ');
      return { type: 'text', text: `Linked resource ${label} <${block.uri}>${details ? ` (${details})` : ''}` };
    }
    case 'resource': {
      const { resource } = block;
      if ('text' in resource) {
        const kind = resource.mimeType === undefined ? '' : ` (${resource.mimeType})`;
        return { type: 'text', text: `Resource ${resource.uri}${kind}:\n${resource.text}` };
      }
      const mimeType = resource.mimeType ?? 'application/octet-stream';
      return inlineMedia(mediaKindOf(mimeType), resource.blob, mimeType, basename(resource.uri));
    }
    case 'image_url': {
      const url = Predicate.isString(block.image_url) ? block.image_url : block.image_url.url;
      return Option.match(parseDataUrl(url), {
        onNone: (): AgentContentBlock => ({ type: 'image', url }),
        onSome: (inline) => inlineMedia('image', inline.data, inline.mimeType, undefined),
      });
    }
    default:
      return block;
  }
};

/**
 * Reads a value as a list of content blocks: MCP's (`text`, `image`, `audio`,
 * `resource`, `resource_link`), LangChain's standard ones, or `image_url`.
 * Anything else, including a list with one unknown block, is not content.
 */
export const contentBlocksOf = (value: Json): Option.Option<ReadonlyArray<AgentContentBlock>> =>
  Option.map(decodeIncomingBlocks(value), (blocks) => blocks.map(normalizeBlock));

const hasMedia = (blocks: ReadonlyArray<AgentContentBlock>): boolean => blocks.some((block) => block.type !== 'text');

const textOf = (blocks: ReadonlyArray<AgentContentBlock>): string =>
  blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');

/** The neutral block as LangChain's standard content block. */
const standardBlock = (block: AgentContentBlock): JsonObject => {
  if (block.type === 'text') return { type: 'text', text: block.text };
  const draft: JsonObjectDraft = { type: block.type };
  if (isInline(block)) {
    draft.data = block.data;
    draft.mimeType = block.mimeType;
  } else {
    draft.url = block.url;
    if (block.mimeType !== undefined) draft.mimeType = block.mimeType;
  }
  const filename = block.metadata?.filename;
  if (filename !== undefined) draft.metadata = { filename };
  return draft;
};

/**
 * What a tool hands the model. Content blocks with media stay blocks (in
 * LangChain's standard form) so the provider rendering can place them; a list
 * of text blocks becomes one text, which every provider takes as a tool result.
 * Any other value is returned unchanged.
 */
export const toolOutputContent = (output: Json): Json =>
  Option.match(contentBlocksOf(output), {
    onNone: () => output,
    onSome: (blocks) => (hasMedia(blocks) ? blocks.map(standardBlock) : textOf(blocks)),
  });

const fileFromPart = (file: Extract<AgentRunPart, { readonly kind: 'file' }>['file']): AgentContentBlock => {
  if ('bytes' in file) {
    const mimeType = file.mimeType ?? 'application/octet-stream';
    return inlineMedia(mediaKindOf(mimeType), file.bytes, mimeType, file.name);
  }
  const mimeType = file.mimeType;
  const type = mimeType === undefined ? 'file' : mediaKindOf(mimeType);
  if (!/^https?:/i.test(file.uri)) {
    return {
      type: 'text',
      text: `[${file.name ?? 'file'} at ${file.uri}: only http(s) links can be passed to the model]`,
    };
  }
  const linked: LinkedMedia = mimeType === undefined ? { type, url: file.uri } : { type, url: file.uri, mimeType };
  return file.name === undefined ? linked : { ...linked, metadata: { filename: file.name } };
};

const partBlock = (part: AgentRunPart): AgentContentBlock => {
  switch (part.kind) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'data':
      return { type: 'text', text: JSON.stringify(part.data, null, 2) };
    case 'file':
      return fileFromPart(part.file);
  }
};

/**
 * The user turn from a caller's parts: plain text when the parts are all text,
 * otherwise standard content blocks (data parts as JSON text, files inline or
 * by URL).
 */
export const userMessage = (parts: ReadonlyArray<AgentRunPart>): HumanMessage => {
  const blocks = parts.map(partBlock);
  if (!hasMedia(blocks)) return new HumanMessage(textOf(blocks));
  // SAFETY: `standardBlock` builds LangChain standard content blocks.
  return new HumanMessage({ content: blocks.map(standardBlock) as MessageContent });
};

const blockPart = (block: AgentContentBlock): AgentRunPart => {
  if (block.type === 'text') return { kind: 'text', text: block.text };
  const name = block.metadata?.filename;
  if (isInline(block)) {
    return name === undefined
      ? { kind: 'file', file: { bytes: block.data, mimeType: block.mimeType } }
      : { kind: 'file', file: { bytes: block.data, mimeType: block.mimeType, name } };
  }
  const file = block.mimeType === undefined ? { uri: block.url } : { uri: block.url, mimeType: block.mimeType };
  return { kind: 'file', file: name === undefined ? file : { ...file, name } };
};

/**
 * A LangChain message as run-record parts: its text, and its media as file
 * parts, so a record shows what the agent was given and not only the words.
 */
export const messageParts = (message: BaseMessage): ReadonlyArray<AgentRunPart> => {
  if (Predicate.isString(message.content)) return [{ kind: 'text', text: message.content }];
  return Option.match(contentBlocksOf(coerceJson(message.content)), {
    onNone: () => [{ kind: 'text', text: message.text }],
    onSome: (blocks) => blocks.map(blockPart),
  });
};

// ---------------------------------------------------------------- providers

/**
 * How a provider's API takes content. `standard` leaves LangChain's standard
 * blocks to the model class, for chat models a host constructed itself.
 */
export type ContentFormat = 'openai-responses' | 'openai-chat' | 'anthropic' | 'google' | 'mistral' | 'standard';

const TEXT_MIME =
  /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|toml|csv|javascript|typescript|sql|graphql|x-sh)\b)|\+(?:json|xml)\b/i;

const isTextLike = (block: MediaBlock): block is InlineMedia => isInline(block) && TEXT_MIME.test(block.mimeType);

const decodeBase64Text = (data: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

const describe = (block: MediaBlock): string => {
  const filename = block.metadata?.filename;
  const parts = [block.mimeType ?? 'unknown type'];
  if (isInline(block)) parts.push(`${Math.round((block.data.length * 3) / 4 / 1024)} KB`);
  const where = isInline(block) ? '' : ` at ${block.url}`;
  return `${block.type}${filename === undefined ? '' : ` "${filename}"`} (${parts.join(', ')})${where}`;
};

const omitted = (block: MediaBlock, format: ContentFormat): string =>
  `[${describe(block)} not shown: the ${format} API takes no ${block.type} here]`;

const sourceUrl = (block: MediaBlock): string =>
  isInline(block) ? `data:${block.mimeType};base64,${block.data}` : block.url;

/** The audio Chat Completions takes, by MIME type. */
const AUDIO_FORMATS = new Map([
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
]);

const textPart = (text: string, format: ContentFormat): JsonObject =>
  format === 'openai-responses' ? { type: 'input_text', text } : { type: 'text', text };

/** A media block as the provider takes it in a user message, or `None` if it cannot. */
const userMedia = (block: MediaBlock, format: ContentFormat): Option.Option<JsonObject> => {
  if (block.type === 'file' && isTextLike(block)) {
    const name = block.metadata?.filename ?? 'file';
    return Option.some(textPart(`${name} (${block.mimeType}):\n${decodeBase64Text(block.data)}`, format));
  }
  const filename = block.metadata?.filename ?? 'file';
  switch (format) {
    case 'standard':
    case 'google':
      return Option.some(standardBlock(block));
    case 'anthropic':
      if (block.type === 'image') return Option.some(standardBlock(block));
      if (block.type === 'file' && block.mimeType === 'application/pdf') return Option.some(standardBlock(block));
      return Option.none();
    case 'openai-responses':
      if (block.type === 'image')
        return Option.some({ type: 'input_image', image_url: sourceUrl(block), detail: 'auto' });
      if (block.type === 'file') {
        return Option.some(
          isInline(block)
            ? { type: 'input_file', file_data: sourceUrl(block), filename }
            : { type: 'input_file', file_url: block.url },
        );
      }
      return Option.none();
    case 'openai-chat':
      if (block.type === 'image') return Option.some({ type: 'image_url', image_url: { url: sourceUrl(block) } });
      if (block.type === 'file' && isInline(block)) {
        return Option.some({ type: 'file', file: { file_data: sourceUrl(block), filename } });
      }
      if (block.type === 'audio' && isInline(block)) {
        const audioFormat = AUDIO_FORMATS.get(block.mimeType);
        if (audioFormat !== undefined) {
          return Option.some({ type: 'input_audio', input_audio: { data: block.data, format: audioFormat } });
        }
      }
      return Option.none();
    case 'mistral':
      return block.type === 'image'
        ? Option.some({ type: 'image_url', image_url: { url: sourceUrl(block) } })
        : Option.none();
  }
};

const userParts = (blocks: ReadonlyArray<AgentContentBlock>, format: ContentFormat): ReadonlyArray<JsonObject> =>
  blocks.map((block) =>
    block.type === 'text'
      ? textPart(block.text, format)
      : Option.getOrElse(userMedia(block, format), () => textPart(omitted(block, format), format)),
  );

/** Whether a provider takes media inside a tool result rather than only text. */
const takesToolMedia = (format: ContentFormat): boolean => format === 'openai-responses' || format === 'anthropic';

/** Media a provider cannot take inside a tool result, shown to it in a user message right after. */
type Attachment = { readonly toolName: string; readonly block: MediaBlock; readonly part: JsonObject };

const toolParts = (
  blocks: ReadonlyArray<AgentContentBlock>,
  format: ContentFormat,
  toolName: string,
  attachments: Array<Attachment>,
): MessageContent => {
  if (takesToolMedia(format)) {
    // SAFETY: the parts are provider-native content parts built above; the
    // provider's converter passes them through as the tool result's content.
    return userParts(blocks, format) as MessageContent;
  }
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      return Option.match(userMedia(block, format), {
        onNone: () => omitted(block, format),
        onSome: (part) => {
          attachments.push({ toolName, block, part });
          return `[${describe(block)}: attachment ${attachments.length}, shown in the next message]`;
        },
      });
    })
    .join('\n\n');
};

const attachmentMessage = (attachments: ReadonlyArray<Attachment>, format: ContentFormat): HumanMessage =>
  new HumanMessage({
    // SAFETY: provider-native content parts, built by `userMedia` for this format.
    content: [
      textPart('The tool results above returned these attachments:', format),
      ...attachments.flatMap((attachment, index) => [
        textPart(`Attachment ${index + 1} from ${attachment.toolName}: ${describe(attachment.block)}`, format),
        attachment.part,
      ]),
    ] as MessageContent,
  });

const contentBlocksOfMessage = (message: BaseMessage): Option.Option<ReadonlyArray<AgentContentBlock>> =>
  Predicate.isString(message.content)
    ? Option.none()
    : Option.filter(contentBlocksOf(coerceJson(message.content)), hasMedia);

/**
 * Rewrites the messages a model call sends so the provider receives every part
 * it can take, in its own format. Messages without media pass unchanged.
 */
export const providerMessages = (messages: ReadonlyArray<BaseMessage>, format: ContentFormat): Array<BaseMessage> => {
  if (format === 'standard') return [...messages];
  const result: Array<BaseMessage> = [];
  let attachments: Array<Attachment> = [];
  const flush = () => {
    if (attachments.length > 0) result.push(attachmentMessage(attachments, format));
    attachments = [];
  };
  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      const blocks = contentBlocksOfMessage(message);
      if (Option.isNone(blocks)) {
        result.push(message);
        continue;
      }
      const fields: ToolMessageFields = {
        content: toolParts(blocks.value, format, message.name ?? message.tool_call_id, attachments),
        tool_call_id: message.tool_call_id,
        status: message.status ?? 'success',
        artifact: message.artifact,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
      };
      if (message.name !== undefined) fields.name = message.name;
      if (message.id !== undefined) fields.id = message.id;
      result.push(new ToolMessage(fields));
      continue;
    }
    flush();
    if (HumanMessage.isInstance(message)) {
      const blocks = contentBlocksOfMessage(message);
      if (Option.isSome(blocks)) {
        const fields: BaseMessageFields = {
          // SAFETY: provider-native content parts, built by `userParts` for this format.
          content: userParts(blocks.value, format) as MessageContent,
          additional_kwargs: message.additional_kwargs,
          response_metadata: message.response_metadata,
        };
        if (message.name !== undefined) fields.name = message.name;
        if (message.id !== undefined) fields.id = message.id;
        result.push(new HumanMessage(fields));
        continue;
      }
    }
    result.push(message);
  }
  flush();
  return result;
};

/** Renders message parts for the model's provider on every model call. */
export const contentPartsMiddleware = (format: ContentFormat) =>
  createMiddleware({
    name: 'AgentdockContentParts',
    wrapModelCall: (request, handler) => handler({ ...request, messages: providerMessages(request.messages, format) }),
  });

/**
 * A tool that throws {@link ToolRunFailure} ends the run instead of answering
 * the model, e.g. when an integration stays unreachable after its retries and
 * an answer would only be "no data". Every other error is answered the way
 * LangChain's tool node does by default, so the model can correct its call.
 */
export const toolRunFailureMiddleware = createMiddleware({
  name: 'AgentdockToolRunFailure',
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (error) {
      if (isGraphInterrupt(error) || isToolRunFailure(error) || request.runtime.signal?.aborted === true) throw error;
      const toolCallId = request.toolCall.id ?? '';
      if (error instanceof ToolInvocationError) {
        return new ToolMessage({ content: error.message, tool_call_id: toolCallId, name: request.toolCall.name });
      }
      return new ToolMessage({
        content: `${String(error)}\n Please fix your mistakes.`,
        tool_call_id: toolCallId,
        name: request.toolCall.name,
      });
    }
  },
});

/**
 * Renders message parts for the model's provider on every call it makes, for
 * code that calls a model directly instead of through an agent. Every way of
 * calling it (invoke, stream, stream events, structured output, bound tools)
 * goes through these methods.
 */
export const renderContentParts = (model: BaseChatModel, format: ContentFormat): void => {
  if (format === 'standard') return;
  const generate = model._generate.bind(model);
  const stream = model._streamResponseChunks.bind(model);
  const streamEvents = model._streamChatModelEvents.bind(model);
  model._generate = (messages, options, runManager) =>
    generate(providerMessages(messages, format), options, runManager);
  model._streamResponseChunks = (messages, options, runManager) =>
    stream(providerMessages(messages, format), options, runManager);
  model._streamChatModelEvents = (messages, options, runManager) =>
    streamEvents(providerMessages(messages, format), options, runManager);
};

/**
 * Applies `decorate` to a chat model and to every copy of itself it makes.
 * `ChatOpenAI#withConfig`, which its `bindTools` and `withStructuredOutput` go
 * through, builds a new model from its constructor fields, so whatever was set
 * on the instance would be missing from a call with tools or structured output.
 */
export const decorateChatModel = <Model extends BaseChatModel>(
  model: Model,
  decorate: (model: BaseChatModel) => void,
): Model => {
  decorate(model);
  const withConfig = model.withConfig.bind(model);
  model.withConfig = (config) => {
    const configured = withConfig(config);
    return configured instanceof BaseChatModel ? decorateChatModel(configured, decorate) : configured;
  };
  return model;
};
