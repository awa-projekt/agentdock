import type { IntegrationToolMode } from 'agentdock-sdk/schemas';
import { Search, Zap } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const TOOL_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: IntegrationToolMode;
  readonly label: string;
  readonly title: string;
  readonly icon: ReactNode;
}> = [
  {
    mode: 'native',
    label: 'Native',
    title: 'Native: called directly by the agent as its own tool',
    icon: <Zap className="size-3.5" />,
  },
  {
    mode: 'codemode',
    label: 'Discoverable',
    title: 'Discoverable: available from inside an executeTs script',
    icon: <Search className="size-3.5" />,
  },
];

export function ToolModeSwitch({
  mode,
  disabled,
  onChange,
}: {
  mode: IntegrationToolMode;
  onChange: (mode: IntegrationToolMode) => void;
  disabled?: boolean;
}) {
  const [optimisticMode, setOptimisticMode] = useState<IntegrationToolMode | null>(null);
  const displayMode = optimisticMode ?? mode;
  // Reset optimistic state when the server-confirmed mode matches it.
  useEffect(() => {
    if (optimisticMode !== null && optimisticMode === mode) setOptimisticMode(null);
  }, [mode, optimisticMode]);

  const selectedIndex = Math.max(
    0,
    TOOL_MODE_OPTIONS.findIndex((o) => o.mode === displayMode),
  );
  const count = TOOL_MODE_OPTIONS.length;

  return (
    <div
      className="relative inline-flex items-center rounded-full border border-border bg-muted/40 p-0.5"
      aria-label="Tool mode"
      role="radiogroup"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 rounded-full bg-background shadow-sm transition-transform duration-200 ease-out"
        style={{
          width: `calc((100% - 0.25rem) / ${count})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {TOOL_MODE_OPTIONS.map((option) => {
        const active = option.mode === displayMode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            aria-label={option.title}
            disabled={disabled === true && optimisticMode === null}
            onClick={() => {
              if (option.mode === displayMode) return;
              setOptimisticMode(option.mode);
              onChange(option.mode);
            }}
            className={cn(
              'relative z-10 flex h-7 w-24 items-center justify-center gap-1 rounded-full px-2 text-[11px] transition-colors duration-150 disabled:cursor-not-allowed',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
