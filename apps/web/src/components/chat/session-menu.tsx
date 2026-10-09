import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { HistoryIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ListSkeleton } from '@/components/Loading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ChatSession } from '@/lib/chat/model';
import { cn } from '@/lib/utils';

const relativeTime = (millis: number): string => {
  const diff = Effect.runSync(Clock.currentTimeMillis) - millis;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : `${Math.floor(days / 7)}w ago`;
};

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (confirming) {
    return (
      <li className="flex items-center gap-2 rounded-md bg-destructive/5 px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-foreground">Delete “{session.title}”?</span>
        <Button
          size="sm"
          variant="destructive"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            void onDelete().finally(() => {
              setDeleting(false);
              setConfirming(false);
            });
          }}
        >
          Delete
        </Button>
        <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </li>
    );
  }

  return (
    <li className="group/row flex items-center gap-1">
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted',
          active && 'bg-muted',
        )}
      >
        <span className="w-full truncate text-xs font-medium text-foreground">{session.title}</span>
        <span className="text-[11px] text-muted-foreground">{relativeTime(session.updatedAt)}</span>
      </button>
      <Button
        variant="destructiveGhost"
        size="icon-sm"
        aria-label={`Delete ${session.title}`}
        className="shrink-0 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

/** Past conversations behind a header button, so the transcript keeps the whole panel. */
export function SessionMenu({
  sessions,
  loading,
  error,
  activeContextId,
  onSelect,
  onDelete,
}: {
  sessions: ReadonlyArray<ChatSession>;
  loading: boolean;
  error: string | null;
  activeContextId: string | undefined;
  onSelect: (contextId: string) => void;
  onDelete: (contextId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const visible =
    needle.length === 0 ? sessions : sessions.filter((session) => session.title.toLowerCase().includes(needle));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Conversation history" title="Conversation history" />
        }
      >
        <HistoryIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="mt-2 h-[min(24rem,60vh)] overflow-y-auto [scrollbar-gutter:stable]">
          {loading ? (
            <ListSkeleton compact />
          ) : error ? (
            <p role="alert" className="p-2 text-xs text-destructive">
              {error}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {sessions.length === 0 ? 'No conversations yet.' : 'No conversations match.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((session) => (
                <SessionRow
                  key={session.contextId}
                  session={session}
                  active={session.contextId === activeContextId}
                  onSelect={() => {
                    onSelect(session.contextId);
                    setOpen(false);
                  }}
                  onDelete={() => onDelete(session.contextId)}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
