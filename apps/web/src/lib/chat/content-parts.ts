import { isJsonArray, type Json, jsonProperty, jsonString } from 'agentdock-sdk/schemas';

/**
 * Tool results made of content blocks, as MCP servers and LangChain write
 * them: text, and images, sound, video or files, inline (base64) or by URL.
 */

type MediaKind = 'image' | 'audio' | 'video' | 'file';

/** A part of a tool result: text, or media inline (base64) or behind a URL, as MCP and LangChain write them. */
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: MediaKind;
      readonly src: string;
      readonly mimeType: string | undefined;
      readonly name: string | undefined;
    };

const mediaKind = (type: string | undefined): MediaKind | undefined =>
  type === 'image' || type === 'audio' || type === 'video' || type === 'file' ? type : undefined;

const mediaKindOf = (mimeType: string | undefined): MediaKind => {
  const kind = mediaKind(mimeType?.split('/')[0]);
  return kind === undefined || kind === 'file' ? 'file' : kind;
};

const mediaPart = (
  kind: MediaKind,
  data: string | undefined,
  url: string | undefined,
  mimeType: string | undefined,
  name: string | undefined,
): ContentPart | undefined => {
  const src = data !== undefined ? `data:${mimeType ?? 'application/octet-stream'};base64,${data}` : url;
  return src === undefined ? undefined : { kind, src, mimeType, name };
};

const contentPart = (block: Json): ContentPart | undefined => {
  const type = jsonString(block, 'type');
  if (type === 'text') {
    const text = jsonString(block, 'text');
    return text === undefined ? undefined : { kind: 'text', text };
  }
  if (type === 'resource_link') {
    const uri = jsonString(block, 'uri');
    return uri === undefined ? undefined : { kind: 'text', text: `[${jsonString(block, 'name') ?? uri}](${uri})` };
  }
  if (type === 'resource') {
    const resource = jsonProperty(block, 'resource');
    const uri = jsonString(resource, 'uri');
    const mimeType = jsonString(resource, 'mimeType');
    const text = jsonString(resource, 'text');
    if (text !== undefined) return { kind: 'text', text };
    return mediaPart(mediaKindOf(mimeType), jsonString(resource, 'blob'), undefined, mimeType, uri?.split('/').at(-1));
  }
  const kind = mediaKind(type);
  if (kind === undefined) return undefined;
  return mediaPart(
    kind,
    jsonString(block, 'data'),
    jsonString(block, 'url'),
    jsonString(block, 'mimeType'),
    jsonString(jsonProperty(block, 'metadata'), 'filename'),
  );
};

/**
 * A tool result made of content blocks with at least one image, sound, video
 * or file in it, each keyed by its place in the result, which never changes.
 */
export const contentParts = (value: Json | undefined): ReadonlyArray<readonly [string, ContentPart]> | undefined => {
  if (!isJsonArray(value) || value.length === 0) return undefined;
  const parts = value.map(contentPart);
  if (parts.some((part) => part === undefined)) return undefined;
  const known = parts.flatMap((part, position) => (part === undefined ? [] : [[`part-${position}`, part] as const]));
  return known.some(([, part]) => part.kind !== 'text') ? known : undefined;
};
