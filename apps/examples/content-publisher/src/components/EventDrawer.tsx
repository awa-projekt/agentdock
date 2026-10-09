import { X } from 'lucide-react';
import { z } from 'zod';
import type { Post, WorkflowEvent } from '../lib/types';
import { cn } from './ui';

const DOT = new Map<string, string>([
  ['run-started', 'bg-slate-400'],
  ['run-completed', 'bg-emerald-500'],
  ['run-failed', 'bg-rose-500'],
  ['run-canceled', 'bg-slate-400'],
  ['step-started', 'bg-sky-400'],
  ['step-progress', 'bg-sky-300'],
  ['step-completed', 'bg-emerald-400'],
  ['step-failed', 'bg-rose-500'],
  ['human-input-requested', 'bg-indigo-500'],
  ['human-input-resolved', 'bg-indigo-400'],
]);

/** The event fields this drawer renders; anything else is shown as raw JSON. */
const EventFields = z
  .looseObject({
    id: z.string().optional(),
    stepId: z.string().optional(),
    state: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .catch({});

const label = (event: WorkflowEvent): string => {
  const fields = EventFields.parse(event);
  const parts = [event.type];
  if (fields.stepId) parts.push(`· ${fields.stepId}`);
  if (event.type === 'step-progress' && fields.state) parts.push(`· ${fields.state}`);
  return parts.join(' ');
};

const EventRow = ({ event }: { event: WorkflowEvent }) => {
  const timestamp = EventFields.parse(event).timestamp;
  return (
    <details className="group border-b border-slate-100 px-4 py-2.5">
      <summary className="flex cursor-pointer items-center gap-2 text-sm marker:content-['']">
        <span className={cn('size-2 shrink-0 rounded-full', DOT.get(event.type) ?? 'bg-slate-300')} />
        <span className="font-medium text-slate-700">{label(event)}</span>
        {timestamp !== undefined && (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-slate-400">
            {new Date(timestamp).toLocaleTimeString()}
          </span>
        )}
      </summary>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-200">
        {JSON.stringify(event, null, 2)}
      </pre>
    </details>
  );
};

export const EventDrawer = ({
  open,
  onClose,
  events,
  post,
}: {
  open: boolean;
  onClose: () => void;
  events: WorkflowEvent[];
  post: Post | undefined;
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />
      <aside className="relative flex w-[30rem] max-w-full flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-200 p-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Workflow events</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              The raw AgentDock run-event stream this UI is built on. Everything here is available to your own client —
              step I/O, streamed tokens, tool calls, the human-input gate, and more.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>

        {post?.taskId && (
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
            <span className="font-medium text-slate-600">task</span> {post.taskId}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {events.length ? (
            events.map((event, i) => <EventRow key={EventFields.parse(event).id ?? i} event={event} />)
          ) : (
            <p className="p-6 text-center text-sm text-slate-400">No events yet.</p>
          )}
        </div>
      </aside>
    </div>
  );
};
