import {
  decodeJsonStringOption,
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type Json,
  type JsonArray,
  type JsonObject,
  jsonProperty,
  jsonString,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import { CodeView, formatJson, JsonCode } from '@/components/chat/code-view';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/chat/disclosure';
import { Markdown } from '@/components/markdown';
import { type ContentPart, contentParts } from '@/lib/chat/content-parts';
import { cn } from '@/lib/utils';

const isEmptyValue = (value: Json | undefined): boolean => {
  if (value === undefined || value === null) return true;
  if (isJsonString(value)) return value.length === 0;
  if (isJsonArray(value)) return value.length === 0;
  if (isJsonObject(value)) return Object.keys(value).length === 0;
  return false;
};

const isScalar = (value: Json | undefined): value is string | number | boolean =>
  isJsonString(value) || isJsonNumber(value) || Predicate.isBoolean(value);

const formatArgKey = (key: string): string => key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

const parseJsonText = (text: string): Json => Option.getOrElse(decodeJsonStringOption(text.trim()), (): Json => text);

/** Tool inputs sometimes arrive as a JSON string; expose the object when they do. */
const parseToolInput = (input: Json | undefined): Json | undefined =>
  isJsonString(input) ? parseJsonText(input) : input;

const shortToolName = (toolName: string): string => toolName.split(/[.:/]/).pop() ?? toolName;

const executeCodeSource = (toolName: string, input: Json | undefined): string | undefined =>
  shortToolName(toolName) === 'executeTs' ? jsonString(input, 'code') : undefined;

function ArgsTable({ args }: { args: JsonObject }) {
  const entries = Object.entries(args).filter(([, value]) => !isEmptyValue(value));
  if (entries.length === 0) return null;

  return (
    <dl className="grid gap-1.5 text-[11px]">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="pt-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {formatArgKey(key)}
          </dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {isScalar(value) ? <span className="text-foreground">{String(value)}</span> : <JsonCode value={value} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// MCP tool results arrive wrapped as { text, structured: { status, result, logs }, isError },
// where `result`/`text` are themselves stringified JSON. Unwrap to the meaningful payload.
type ResultPayload = { readonly payload: Json | undefined; readonly logs: JsonArray };

const extractResultPayload = (value: Json | undefined): ResultPayload => {
  const structured = jsonProperty(value, 'structured');
  const text = jsonString(value, 'text');
  const isEnvelope = isJsonObject(value) && 'isError' in value && (isJsonObject(structured) || text !== undefined);

  if (isEnvelope) {
    const structuredObject = isJsonObject(structured) ? structured : null;
    const rawResult = (structuredObject === null ? undefined : jsonString(structuredObject, 'result')) ?? text;
    const payload = rawResult === undefined ? (structuredObject ?? value) : parseJsonText(rawResult);
    const logs = structuredObject === null ? null : jsonProperty(structuredObject, 'logs');
    return { payload, logs: isJsonArray(logs) ? logs : [] };
  }

  if (isJsonString(value)) {
    const parsed = parseJsonText(value);
    return isJsonString(parsed) ? { payload: parsed, logs: [] } : extractResultPayload(parsed);
  }
  return { payload: value, logs: [] };
};

function ContentPartView({ part }: { part: ContentPart }) {
  switch (part.kind) {
    case 'text':
      return <ResultBlock value={part.text} />;
    case 'image':
      return (
        <img
          src={part.src}
          alt={part.name ?? 'Image returned by the tool'}
          className="max-h-80 max-w-full rounded-md border border-border/70 object-contain"
        />
      );
    // Tools return media without captions; the empty track says there are none.
    case 'audio':
      return (
        <audio src={part.src} controls className="w-full">
          <track kind="captions" />
        </audio>
      );
    case 'video':
      return (
        <video src={part.src} controls className="max-h-80 max-w-full rounded-md">
          <track kind="captions" />
        </video>
      );
    case 'file':
      return (
        <a
          href={part.src}
          download={part.name ?? true}
          className="text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {part.name ?? 'File'} {part.mimeType ? `(${part.mimeType})` : ''}
        </a>
      );
  }
}

function ContentParts({ parts }: { parts: ReadonlyArray<readonly [string, ContentPart]> }) {
  return (
    <div className="grid gap-2">
      {parts.map(([key, part]) => (
        <ContentPartView key={key} part={part} />
      ))}
    </div>
  );
}

function ResultBlock({ value }: { value: Json | undefined }) {
  const parts = contentParts(value);
  if (parts !== undefined) return <ContentParts parts={parts} />;
  const { payload, logs } = extractResultPayload(value);

  if (isEmptyValue(payload) && logs.length === 0) {
    return <p className="text-[11px] italic text-muted-foreground">No result</p>;
  }

  return (
    <div className="grid gap-2">
      {isJsonString(payload) ? (
        <Markdown className="text-xs">{payload}</Markdown>
      ) : isEmptyValue(payload) ? null : (
        <JsonCode value={payload} />
      )}
      {logs.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Logs</div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 font-mono text-[10.5px] leading-snug text-foreground/80">
            {logs.map((line) => (isJsonString(line) ? line : formatJson(line))).join('\n')}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({
  label,
  toolName,
  tone,
  defaultOpen,
  children,
}: {
  label: string;
  toolName: string;
  tone: 'call' | 'result' | 'error';
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <Disclosure
      defaultOpen={defaultOpen}
      className={cn(
        'rounded-lg border px-2.5 py-2',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/5'
          : tone === 'call'
            ? 'border-border/70 bg-muted/30'
            : 'border-success/30 bg-success/5',
      )}
    >
      <DisclosureTrigger>
        <span className="shrink-0 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
          {label}
        </span>
        <span className="truncate font-mono text-[12px] font-medium text-foreground">{toolName}</span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-2 min-w-0">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

export function ToolCallCard({
  toolName,
  input,
  defaultOpen = true,
}: {
  toolName: string;
  input: Json | undefined;
  defaultOpen?: boolean;
}) {
  const parsed = parseToolInput(input);
  const codeSource = executeCodeSource(toolName, parsed);

  return (
    <ToolCard label="Call" toolName={toolName} tone="call" defaultOpen={defaultOpen}>
      {codeSource !== undefined ? (
        <CodeView code={codeSource} />
      ) : isJsonObject(parsed) && Object.keys(parsed).length > 0 ? (
        <ArgsTable args={parsed} />
      ) : parsed === undefined || isEmptyValue(parsed) ? (
        <p className="text-[11px] italic text-muted-foreground">No arguments</p>
      ) : (
        <JsonCode value={parsed} />
      )}
    </ToolCard>
  );
}

export function ToolResultCard({
  toolName,
  output,
  error,
  defaultOpen = true,
}: {
  toolName: string;
  output: Json | undefined;
  error: string | undefined;
  defaultOpen?: boolean;
}) {
  return (
    <ToolCard
      label={error ? 'Error' : 'Result'}
      toolName={toolName}
      tone={error ? 'error' : 'result'}
      defaultOpen={defaultOpen}
    >
      {error ? (
        <p className="whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>
      ) : (
        <ResultBlock value={output} />
      )}
    </ToolCard>
  );
}
