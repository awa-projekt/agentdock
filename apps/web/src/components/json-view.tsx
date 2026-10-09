import { isJsonArray, isJsonObject, type Json } from 'agentdock-sdk/schemas';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { expandJsonString, formatJson, JsonCode } from '@/components/chat/code-view';
import { CopyButton } from '@/components/copy-button';
import { pluralise } from '@/lib/format';
import { cn } from '@/lib/utils';

const summarise = (value: Json): string => {
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return 'empty object';
    return `${pluralise(keys.length, 'field')}: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`;
  }
  if (isJsonArray(value)) return value.length === 0 ? 'empty list' : pluralise(value.length, 'item');
  const text = JSON.stringify(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
};

export function JsonView({
  value,
  label,
  defaultOpen = false,
  className,
}: {
  value: Json;
  label: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = expandJsonString(value);

  if (expanded === null || expanded === '') {
    return (
      <div className={cn('flex h-7 min-w-0 items-center gap-1 px-1.5 font-mono text-xs', className)}>
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">· {expanded === null ? 'null' : 'empty'}</span>
      </div>
    );
  }

  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 font-mono text-xs transition-colors hover:bg-muted"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-medium whitespace-nowrap">{label}</span>
        <span className="min-w-0 truncate text-muted-foreground">· {summarise(expanded)}</span>
      </button>
      {open ? (
        <div className="relative">
          <JsonCode
            value={expanded}
            className="max-h-96 overflow-auto rounded-md bg-muted/60 py-2.5 pr-10 pl-3 text-xs leading-relaxed"
          />
          <CopyButton value={formatJson(expanded)} label={label} className="absolute top-1 right-1" />
        </div>
      ) : null}
    </div>
  );
}
