import type { ReactNode } from "react";

type EventRenderer = (event: TimelineEvent) => ReactNode;

const TS_KEYWORDS = new Set([
  "const", "let", "var", "function", "async", "await", "return", "if", "else",
  "for", "while", "do", "switch", "case", "default", "break", "continue", "new",
  "this", "super", "try", "catch", "finally", "throw", "import", "export", "from",
  "as", "of", "in", "typeof", "instanceof", "void", "delete", "yield",
  "class", "extends", "implements", "interface", "type", "enum", "namespace",
  "public", "private", "protected", "readonly", "static", "abstract", "declare",
]);

const TS_CONSTANTS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

type CodeToken = { readonly type: string; readonly value: string };

const TS_TOKEN_RE =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

const tokenizeTs = (code: string): ReadonlyArray<CodeToken> => {
  const tokens: Array<CodeToken> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TS_TOKEN_RE.lastIndex = 0;
  while ((match = TS_TOKEN_RE.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "plain", value: code.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: "comment", value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "string", value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: "number", value: match[3] });
    } else if (match[4] !== undefined) {
      const word = match[4];
      if (TS_KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (TS_CONSTANTS.has(word)) {
        tokens.push({ type: "constant", value: word });
      } else {
        const after = code.charAt(match.index + word.length);
        tokens.push({ type: after === "(" ? "function" : "identifier", value: word });
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < code.length) {
    tokens.push({ type: "plain", value: code.slice(lastIndex) });
  }
  return tokens;
};

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-muted-foreground italic",
  string: "text-emerald-500 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  keyword: "text-violet-600 dark:text-violet-400",
  constant: "text-sky-600 dark:text-sky-400",
  function: "text-sky-700 dark:text-sky-300",
  identifier: "text-foreground/90",
  plain: "text-foreground/80",
};

function CodeBlock({ code, language = "ts" }: { code: string; language?: string }) {
  const tokens = tokenizeTs(code);
  return (
    <div className="overflow-hidden rounded-md border border-border/50 bg-background/70">
      <div className="flex items-center justify-between border-b border-border/40 px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {language}
        </span>
      </div>
      <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        <code>
          {tokens.map((token, index) => (
            <span key={index} className={TOKEN_CLASS[token.type] ?? TOKEN_CLASS.plain}>
              {token.value}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

type TimelineEvent = {
  readonly kind: string;
  readonly summary: string;
  readonly details?: string;
  readonly raw?: string;
  readonly rawEvent?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatJson = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getToolDataFromEvent = (event: TimelineEvent): Record<string, unknown> | null => {
  const raw = event.rawEvent;
  if (!isRecord(raw)) return null;

  if (raw.kind === "status-update" && isRecord(raw.status) && isRecord(raw.status.message)) {
    return findToolDataPart(raw.status.message);
  }

  if (raw.kind === "task" && Array.isArray(raw.history)) {
    for (const message of [...raw.history].reverse()) {
      const data = findToolDataPart(message);
      if (data) return data;
    }
  }

  if (isRecord(raw.data) && typeof raw.data.type === "string") {
    return raw.data;
  }

  return null;
};

const findToolDataPart = (message: unknown): Record<string, unknown> | null => {
  if (!isRecord(message) || !Array.isArray(message.parts)) return null;
  for (const part of message.parts) {
    if (isRecord(part) && part.kind === "data" && isRecord(part.data) && typeof part.data.type === "string") {
      return part.data;
    }
  }
  return null;
};

const valueIsEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
};

const formatArgKey = (key: string): string =>
  key.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function ArgsTable({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([, value]) => !valueIsEmpty(value));
  if (entries.length === 0) return null;

  return (
    <div className="grid gap-1.5 text-[11px]">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[max-content_1fr] gap-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {formatArgKey(key)}
          </div>
          <div className="min-w-0 [overflow-wrap:anywhere]">
            {isPrimitive(value) ? (
              <span className="text-foreground">{String(value)}</span>
            ) : (
              <pre className="overflow-x-auto rounded bg-background/60 p-1.5 font-mono text-[10px] leading-snug text-foreground/90">
                {formatJson(value)}
              </pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const tryParseJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
};

// MCP tool results arrive wrapped as { text, structured: { status, result, logs }, isError },
// where `result`/`text` are themselves stringified JSON. Unwrap to the meaningful payload.
const extractResultPayload = (
  value: unknown,
): { readonly payload: unknown; readonly logs: ReadonlyArray<unknown> } => {
  if (isRecord(value) && "isError" in value && (isRecord(value.structured) || typeof value.text === "string")) {
    const structured = isRecord(value.structured) ? value.structured : null;
    const rawResult =
      structured && typeof structured.result === "string"
        ? structured.result
        : typeof value.text === "string"
          ? value.text
          : null;
    const payload = rawResult !== null ? tryParseJson(rawResult) : (structured ?? value);
    const logs = structured && Array.isArray(structured.logs) ? structured.logs : [];
    return { payload, logs };
  }
  if (typeof value === "string") {
    return { payload: tryParseJson(value), logs: [] };
  }
  return { payload: value, logs: [] };
};

const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d[\d.eE+-]*\b)|\b(true|false|null)\b/g;

const JSON_TOKEN_CLASS: Record<string, string> = {
  key: "text-sky-700 dark:text-sky-300",
  string: "text-emerald-600 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  constant: "text-violet-600 dark:text-violet-400",
  plain: "text-foreground/70",
};

const tokenizeJson = (code: string): ReadonlyArray<CodeToken> => {
  const tokens: Array<CodeToken> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  JSON_TOKEN_RE.lastIndex = 0;
  while ((match = JSON_TOKEN_RE.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "plain", value: code.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: match[2] ? "key" : "string", value: match[1] });
      if (match[2]) tokens.push({ type: "plain", value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: "number", value: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: "constant", value: match[4] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < code.length) {
    tokens.push({ type: "plain", value: code.slice(lastIndex) });
  }
  return tokens;
};

function JsonView({ value }: { value: unknown }) {
  const tokens = tokenizeJson(formatJson(value));
  return (
    <pre className="max-h-72 overflow-auto rounded bg-background/60 p-2 font-mono text-[10px] leading-snug">
      <code>
        {tokens.map((token, index) => (
          <span key={index} className={JSON_TOKEN_CLASS[token.type] ?? JSON_TOKEN_CLASS.plain}>
            {token.value}
          </span>
        ))}
      </code>
    </pre>
  );
}

function ResultBlock({ value }: { value: unknown }) {
  const { payload, logs } = extractResultPayload(value);

  if (valueIsEmpty(payload) && logs.length === 0) {
    return <div className="text-[11px] italic text-muted-foreground">No result</div>;
  }

  return (
    <div className="grid gap-2">
      {typeof payload === "string" ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-[11px] leading-snug text-foreground/90">
          {payload}
        </pre>
      ) : valueIsEmpty(payload) ? null : (
        <JsonView value={payload} />
      )}
      {logs.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Logs</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-[10px] leading-snug text-foreground/80">
            {logs.map((line) => (typeof line === "string" ? line : formatJson(line))).join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

const isExecuteCodeInput = (
  toolName: string,
  input: Record<string, unknown> | undefined,
): input is { readonly code: string } => {
  if (!input || typeof input.code !== "string") return false;
  const normalized = toolName.split(/[.:/]/).pop() ?? toolName;
  return normalized === "execute";
};

function ToolCallCard({
  toolName,
  input,
  variant = "call",
}: {
  toolName: string;
  input: Record<string, unknown> | undefined;
  variant?: "call" | "error";
}) {
  const accent =
    variant === "error"
      ? "border-destructive/30 bg-destructive/5"
      : "border-sky-500/25 bg-sky-500/5";
  const label = variant === "error" ? "Tool call failed" : "Tool call";
  const codeInput = isExecuteCodeInput(toolName, input) ? input : null;

  return (
    <div className={`rounded-md border p-2.5 ${accent}`}>
      <div className="flex items-center gap-2">
        <span className="rounded-sm bg-background/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[12px] font-semibold text-foreground">{toolName}</span>
      </div>
      {codeInput ? (
        <div className="mt-2">
          <CodeBlock code={codeInput.code} language="ts" />
        </div>
      ) : input && Object.keys(input).length > 0 ? (
        <div className="mt-2">
          <ArgsTable args={input} />
        </div>
      ) : null}
    </div>
  );
}

function ToolResultCard({
  toolName,
  output,
  error,
}: {
  toolName: string;
  output: unknown;
  error?: string;
}) {
  const accent = error
    ? "border-destructive/30 bg-destructive/5"
    : "border-emerald-500/25 bg-emerald-500/5";
  const label = error ? "Result (error)" : "Result";

  return (
    <div className={`rounded-md border p-2.5 ${accent}`}>
      <div className="flex items-center gap-2">
        <span className="rounded-sm bg-background/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[12px] font-semibold text-foreground">{toolName}</span>
      </div>
      <div className="mt-2">
        {error ? (
          <div className="rounded bg-destructive/10 p-2 text-[11px] text-destructive">{error}</div>
        ) : (
          <ResultBlock value={output} />
        )}
      </div>
    </div>
  );
}

const renderOpinionatedToolEvent: EventRenderer = (event) => {
  const data = getToolDataFromEvent(event);
  if (!data || typeof data.type !== "string") return null;

  const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
  const input = isRecord(data.input) ? data.input : undefined;

  if (data.type === "tool-call") {
    return <ToolCallCard toolName={toolName} input={input} />;
  }

  if (data.type === "tool-result") {
    return <ToolResultCard toolName={toolName} output={data.output} />;
  }

  if (data.type === "tool-error") {
    const errorText = typeof data.error === "string" ? data.error : "Tool error";
    return <ToolResultCard toolName={toolName} output={data.output} error={errorText} />;
  }

  return null;
};

const renderArtifactTextEvent: EventRenderer = (event) => {
  const raw = event.rawEvent;
  if (!isRecord(raw) || raw.kind !== "artifact-update" || !isRecord(raw.artifact)) return null;

  const parts = raw.artifact.parts;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .flatMap((part) =>
      isRecord(part) && part.kind === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");

  if (text.length === 0) return null;

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 p-2 text-[11px] leading-snug text-foreground/90">
      {text}
    </pre>
  );
};

export const opinionatedEventRenderers: ReadonlyArray<EventRenderer> = [
  renderOpinionatedToolEvent,
  renderArtifactTextEvent,
];
