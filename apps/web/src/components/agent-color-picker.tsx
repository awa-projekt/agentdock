import { AGENT_COLOR_PALETTE, AgentColor, type AgentColor as AgentColorValue } from 'agentdock-sdk/schemas';
import { Palette } from 'lucide-react';
import { useId } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function AgentColorPicker({
  value,
  onChange,
  label = 'Agent color',
  compact = false,
  id,
}: {
  value: AgentColorValue;
  onChange: (color: AgentColorValue) => void;
  label?: string;
  compact?: boolean;
  id?: string;
}) {
  const customColorId = useId();

  return (
    <Popover>
      <PopoverTrigger
        id={id}
        className={cn(buttonVariants({ variant: 'outline', size: compact ? 'icon' : 'default' }), compact && 'size-8')}
      >
        <span className="size-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: value }} />
        {compact ? <span className="sr-only">{label}</span> : <span>{label}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Palette className="size-4" />
          {label}
        </div>
        <div className="mt-3 grid grid-cols-8 gap-2">
          {AGENT_COLOR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'size-6 rounded-full border border-black/10 ring-offset-2 transition-transform hover:scale-110',
                value === color && 'ring-2 ring-ring',
              )}
              style={{ backgroundColor: color }}
              onClick={() => onChange(color)}
              aria-label={`Use ${color}`}
              aria-pressed={value === color}
            />
          ))}
        </div>
        <label htmlFor={customColorId} className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          Custom color
          <Input
            type="color"
            id={customColorId}
            value={value}
            onChange={(event) => onChange(AgentColor.make(event.target.value))}
            className="h-8 w-14 cursor-pointer p-1"
          />
          <span className="font-mono">{value}</span>
        </label>
      </PopoverContent>
    </Popover>
  );
}
