import { useQuery } from '@tanstack/react-query';
import { Check, GitCompare, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { diffLines, hasChanges } from '../lib/diff';
import { renderMarkdown, splitTitle } from '../lib/markdown';
import type { Post } from '../lib/types';
import type { Runs } from '../lib/useRuns';
import { Button, Card, cn, Spinner } from './ui';

const FALLBACK_CHANNELS = ['blog', 'twitter', 'linkedin', 'newsletter'];
type Tab = 'edit' | 'preview' | 'diff';

export const ReviewEditor = ({ post, runs }: { post: Post; runs: Runs }) => {
  const seed = useMemo(() => splitTitle(post.draft), [post.draft]);
  const [title, setTitle] = useState(post.title ?? seed.title);
  const [body, setBody] = useState(seed.body);
  const [channel, setChannel] = useState(post.channel ?? 'blog');
  const [feedback, setFeedback] = useState('');
  const [tab, setTab] = useState<Tab>('edit');

  const busy = runs.isBusy(post.id);
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });
  const options = channels.data?.channels ?? FALLBACK_CHANNELS;

  const edited = hasChanges(seed.body, body);
  const rows = useMemo(() => diffLines(seed.body, body), [seed.body, body]);

  const approve = () => runs.submitReview(post.id, { approved: true, title, body, channel });
  const reject = () => runs.submitReview(post.id, { approved: false, feedback });

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-indigo-50/50 px-5 py-3">
        <p className="text-sm font-semibold text-indigo-900">{post.reviewTitle ?? 'Review & approve'}</p>
        {post.reviewDescription && <p className="mt-0.5 text-xs text-indigo-700/80">{post.reviewDescription}</p>}
      </div>

      <div className="space-y-4 p-5">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Channel</span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-slate-500">
            {(['edit', 'preview', 'diff'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 capitalize',
                  tab === t ? 'bg-slate-800 text-white' : 'hover:bg-slate-100',
                )}
              >
                {t === 'diff' && <GitCompare className="size-3" />}
                {t}
                {t === 'diff' && edited && <span className="ml-0.5 size-1.5 rounded-full bg-amber-400" />}
              </button>
            ))}
          </div>

          {tab === 'edit' && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="w-full resize-y rounded-lg p-3 font-mono text-sm leading-relaxed ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
            />
          )}
          {tab === 'preview' && (
            <div
              className="prose-mini min-h-[14rem] rounded-lg p-3 text-slate-700 ring-1 ring-slate-200"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            />
          )}
          {tab === 'diff' && (
            <div className="min-h-[14rem] overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed ring-1 ring-slate-200">
              {edited ? (
                rows.map((row, i) => (
                  <div
                    key={i}
                    className={cn(
                      'whitespace-pre-wrap',
                      row.type === 'add' && 'bg-emerald-50 text-emerald-700',
                      row.type === 'remove' && 'bg-rose-50 text-rose-600 line-through',
                    )}
                  >
                    <span className="mr-2 select-none text-slate-300">
                      {row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}
                    </span>
                    {row.text || ' '}
                  </div>
                ))
              ) : (
                <p className="text-slate-400">No edits yet — this matches the agent's draft.</p>
              )}
            </div>
          )}
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-slate-500">
            Add feedback (sent with a rejection)
          </summary>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="What should change?"
            className="mt-2 w-full resize-none rounded-lg p-2.5 text-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </details>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="danger" onClick={reject} disabled={busy}>
            <X className="size-4" /> Reject
          </Button>
          <Button onClick={approve} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? <Spinner /> : <Check className="size-4" />}
            Approve &amp; publish
          </Button>
        </div>
      </div>
    </Card>
  );
};
