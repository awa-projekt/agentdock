import type * as React from 'react';

import { Textarea } from '@/components/ui/textarea';
import { tryFormatJson } from '@/lib/format';
import { cn } from '@/lib/utils';

// A monospace textarea for JSON-shaped fields that pretty-prints its contents on
// blur (via the shared tryFormatJson helper, which no-ops on invalid JSON).
// Use this anywhere a JSON value is edited as text so the behavior stays uniform.
export function JsonTextarea({
  value,
  onChange,
  format = true,
  className,
  onBlur,
  spellCheck = false,
  ...props
}: Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  /** Disable blur-time formatting (e.g. for a non-JSON variant of a shared field). */
  format?: boolean;
}) {
  return (
    <Textarea
      {...props}
      value={value}
      spellCheck={spellCheck}
      className={cn('min-h-24 font-mono text-sm', className)}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        if (format) {
          const formatted = tryFormatJson(event.target.value);
          if (formatted !== event.target.value) onChange(formatted);
        }
        onBlur?.(event);
      }}
    />
  );
}
