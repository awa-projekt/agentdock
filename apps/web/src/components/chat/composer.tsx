import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useId } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  disabled,
  placeholder = 'Ask anything',
  textareaRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  placeholder?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}) {
  const id = useId();
  const canSend = !disabled && !streaming && value.trim().length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSubmit();
  };

  return (
    <form
      className={cn('mx-auto w-full max-w-4xl px-4 pb-4 sm:px-6', className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <div
        className={cn(
          'flex items-end gap-2 rounded-[1.4rem] border border-border/80 bg-card/95 p-2 pl-4 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm transition-colors',
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          disabled && 'opacity-70',
        )}
      >
        <label htmlFor={id} className="sr-only">
          Message
        </label>
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="field-sizing-content max-h-48 min-h-7 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {streaming ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            aria-label="Stop generating"
            onClick={onStop}
            className="size-9 rounded-full"
          >
            <SquareIcon className="size-3 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            disabled={!canSend}
            className="size-9 rounded-full"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
