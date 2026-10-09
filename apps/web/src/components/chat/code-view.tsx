import { decodeJsonStringOption, isJsonArray, isJsonObject, isJsonString, type Json } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import { cn } from '@/lib/utils';

const TS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'async',
  'await',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'new',
  'this',
  'super',
  'try',
  'catch',
  'finally',
  'throw',
  'import',
  'export',
  'from',
  'as',
  'of',
  'in',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'yield',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'namespace',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'abstract',
  'declare',
]);

const TS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

type TsTokenType = 'comment' | 'constant' | 'function' | 'identifier' | 'keyword' | 'number' | 'plain' | 'string';
type JsonTokenType = 'constant' | 'key' | 'number' | 'plain' | 'string';

type CodeToken<TType extends string> = { readonly type: TType; readonly value: string };

const TS_TOKEN_RE =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

const tokenizeTs = (source: string): ReadonlyArray<CodeToken<TsTokenType>> => {
  const tokens: Array<CodeToken<TsTokenType>> = [];
  let lastIndex = 0;
  TS_TOKEN_RE.lastIndex = 0;
  for (let match = TS_TOKEN_RE.exec(source); match !== null; match = TS_TOKEN_RE.exec(source)) {
    if (match.index > lastIndex) tokens.push({ type: 'plain', value: source.slice(lastIndex, match.index) });
    if (match[1] !== undefined) {
      tokens.push({ type: 'comment', value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: 'string', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'number', value: match[3] });
    } else if (match[4] !== undefined) {
      const word = match[4];
      if (TS_KEYWORDS.has(word)) {
        tokens.push({ type: 'keyword', value: word });
      } else if (TS_CONSTANTS.has(word)) {
        tokens.push({ type: 'constant', value: word });
      } else {
        const after = source.charAt(match.index + word.length);
        tokens.push({ type: after === '(' ? 'function' : 'identifier', value: word });
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) tokens.push({ type: 'plain', value: source.slice(lastIndex) });
  return tokens;
};

const TS_TOKEN_CLASS = {
  comment: 'text-muted-foreground italic',
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  keyword: 'text-syntax-keyword',
  constant: 'text-syntax-literal',
  function: 'text-syntax-structure',
  identifier: 'text-foreground/90',
  plain: 'text-foreground/80',
} satisfies Record<TsTokenType, string>;

const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d[\d.eE+-]*\b)|\b(true|false|null)\b/g;

const JSON_TOKEN_CLASS = {
  key: 'text-syntax-key',
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  constant: 'text-syntax-keyword',
  plain: 'text-foreground/70',
} satisfies Record<JsonTokenType, string>;

const tokenizeJson = (source: string): ReadonlyArray<CodeToken<JsonTokenType>> => {
  const tokens: Array<CodeToken<JsonTokenType>> = [];
  let lastIndex = 0;
  JSON_TOKEN_RE.lastIndex = 0;
  for (let match = JSON_TOKEN_RE.exec(source); match !== null; match = JSON_TOKEN_RE.exec(source)) {
    if (match.index > lastIndex) tokens.push({ type: 'plain', value: source.slice(lastIndex, match.index) });
    if (match[1] !== undefined) {
      tokens.push({ type: match[2] ? 'key' : 'string', value: match[1] });
      if (match[2]) tokens.push({ type: 'plain', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'number', value: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'constant', value: match[4] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) tokens.push({ type: 'plain', value: source.slice(lastIndex) });
  return tokens;
};

/** Tool results often arrive as serialized JSON; a string holding an object or array is shown as that structure. */
export const expandJsonString = (value: Json): Json => {
  if (!isJsonString(value)) return value;
  return Option.match(decodeJsonStringOption(value), {
    onNone: () => value,
    onSome: (parsed) => (isJsonObject(parsed) || isJsonArray(parsed) ? parsed : value),
  });
};

export const formatJson = (value: Json | undefined): string => {
  if (value === undefined || value === null) return '';
  const expanded = expandJsonString(value);
  return isJsonString(expanded) ? expanded : JSON.stringify(expanded, null, 2);
};

const Tokens = <TType extends string>({
  tokens,
  classes,
}: {
  readonly tokens: ReadonlyArray<CodeToken<TType>>;
  readonly classes: Record<TType, string>;
}) => {
  let offset = 0;
  return tokens.map((token) => {
    const key = `${offset}:${token.type}`;
    offset += token.value.length;
    return (
      <span key={key} className={classes[token.type]}>
        {token.value}
      </span>
    );
  });
};

/** Lightweight TypeScript highlighting for tool code such as `executeTs` sources. */
export function CodeView({
  code,
  language = 'ts',
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-md border border-border/60 bg-background/70', className)}>
      <div className="flex items-center border-b border-border/40 px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{language}</span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        <code>
          <Tokens tokens={tokenizeTs(code)} classes={TS_TOKEN_CLASS} />
        </code>
      </pre>
    </div>
  );
}

export function JsonCode({ value, className }: { value: Json | undefined; className?: string }) {
  return (
    <pre
      className={cn('overflow-x-auto rounded-md bg-background/70 p-2 font-mono text-[10.5px] leading-snug', className)}
    >
      <code>
        <Tokens tokens={tokenizeJson(formatJson(value))} classes={JSON_TOKEN_CLASS} />
      </code>
    </pre>
  );
}
