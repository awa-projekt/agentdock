import { Inbox } from 'lucide-react';
import type { Runs } from '../lib/useRuns';
import { cn, StatusBadge } from './ui';

export const PostList = ({ runs }: { runs: Runs }) => {
  const { posts, selectedId, select } = runs;

  if (!posts.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-slate-400">
        <Inbox className="size-7" />
        <p className="text-sm">No posts yet. Write a brief above to draft one.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {posts.map((post) => (
        <button
          key={post.id}
          onClick={() => select(post.id)}
          className={cn(
            'flex w-full flex-col gap-1.5 border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50',
            selectedId === post.id && 'bg-indigo-50/60 hover:bg-indigo-50/60',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="line-clamp-2 text-sm font-medium text-slate-800">{post.title || post.brief}</span>
            <StatusBadge status={post.status} />
          </div>
          {post.title && <span className="line-clamp-1 text-xs text-slate-400">{post.brief}</span>}
        </button>
      ))}
    </div>
  );
};
