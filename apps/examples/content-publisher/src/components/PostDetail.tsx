import { Check, CheckCircle2, Code2, ExternalLink, Loader2, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';
import type { Post } from '../lib/types';
import type { Runs } from '../lib/useRuns';
import { ReviewEditor } from './ReviewEditor';
import { Button, Card, Spinner, StatusBadge } from './ui';

const Markdown = ({ source }: { source: string }) => (
  <div className="prose-mini text-slate-700" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
);

const Empty = () => (
  <div className="flex h-full items-center justify-center p-10 text-center text-slate-400">
    <div>
      <p className="text-base font-medium text-slate-500">Select or draft a post</p>
      <p className="mt-1 text-sm">An agent drafts it, you review &amp; approve, then a workflow publishes it.</p>
    </div>
  </div>
);

const Drafting = ({ text }: { text: string }) => (
  <Card className="p-6">
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-600">
      <Loader2 className="size-4 animate-spin" /> The agent is writing your draft…
    </div>
    {text ? <Markdown source={text} /> : <p className="text-sm text-slate-400">Waiting for the first tokens…</p>}
  </Card>
);

const Publishing = ({ post }: { post: Post }) => (
  <Card className="p-6">
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-sky-600">
      <Loader2 className="size-4 animate-spin" /> Publishing the approved post…
    </div>
    <Markdown source={post.draft} />
  </Card>
);

/**
 * AgentDock's own approval of the `publish_post` call, shown when its tool
 * policy requires one. It comes after the editorial review and decides the
 * call itself, not the content.
 */
const ToolApproval = ({ post, runs }: { post: Post; runs: Runs }) => {
  const busy = runs.isBusy(post.id);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-violet-50/60 px-5 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-violet-900">
          <ShieldCheck className="size-4" /> {post.reviewTitle ?? 'Approve the tool call'}
        </p>
        <p className="mt-0.5 text-xs text-violet-700/80">
          AgentDock requires an approval before the workflow may call <code>{post.pendingTool}</code>.
        </p>
      </div>
      <div className="space-y-4 p-5">
        {post.title && <h3 className="text-base font-semibold text-slate-800">{post.title}</h3>}
        <Markdown source={post.draft} />
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="danger" onClick={() => runs.decideToolCall(post.id, false)} disabled={busy}>
            <X className="size-4" /> Decline
          </Button>
          <Button onClick={() => runs.decideToolCall(post.id, true)} disabled={busy}>
            {busy ? <Spinner /> : <Check className="size-4" />}
            Approve call
          </Button>
        </div>
      </div>
    </Card>
  );
};

const Revising = ({ post }: { post: Post }) => (
  <Card className="p-6">
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-600">
      <Loader2 className="size-4 animate-spin" /> The agent is working through your feedback…
    </div>
    <Markdown source={post.draft} />
  </Card>
);

const Published = ({ post }: { post: Post }) => (
  <div className="space-y-4">
    <Card className="border-emerald-200 p-5">
      <div className="flex items-center gap-2 text-emerald-700">
        <CheckCircle2 className="size-5" />
        <span className="font-semibold">Published{post.channel ? ` to ${post.channel}` : ''}</span>
      </div>
      {post.publishedUrl && (
        <a
          href={post.publishedUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 underline"
        >
          {post.publishedUrl} <ExternalLink className="size-3.5" />
        </a>
      )}
      {post.finalOutput && <p className="mt-2 text-sm text-slate-500">{post.finalOutput}</p>}
    </Card>
    <Card className="p-6">
      {post.title && <h2 className="mb-2 text-xl font-bold text-slate-800">{post.title}</h2>}
      <Markdown source={post.draft} />
    </Card>
  </div>
);

const Rejected = ({ post }: { post: Post }) => (
  <Card className="p-6">
    <p className="mb-3 text-sm font-medium text-slate-500">You declined to publish this draft.</p>
    {post.finalOutput && <p className="mb-3 text-sm text-slate-500">{post.finalOutput}</p>}
    <Markdown source={post.draft} />
  </Card>
);

const Failed = ({ post }: { post: Post }) => (
  <Card className="border-rose-200 p-6">
    <div className="flex items-center gap-2 text-rose-700">
      <TriangleAlert className="size-5" />
      <span className="font-semibold">The run failed</span>
    </div>
    <p className="mt-2 text-sm text-slate-600">{post.error}</p>
  </Card>
);

export const PostDetail = ({ runs, onOpenEvents }: { runs: Runs; onOpenEvents: () => void }) => {
  const post = runs.selectedPost;
  if (!post) return <Empty />;

  const streaming = runs.streamingFor(post.id);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <StatusBadge status={post.status} />
          </div>
          <h2 className="truncate text-lg font-semibold text-slate-800">{post.title || post.brief}</h2>
          {post.title && <p className="mt-0.5 text-sm text-slate-400">Brief: {post.brief}</p>}
        </div>
        <Button variant="secondary" onClick={onOpenEvents} title="Inspect workflow events">
          <Code2 className="size-4" /> Developer
        </Button>
      </div>

      {post.status === 'drafting' && <Drafting text={streaming || post.draft} />}
      {post.status === 'awaiting-review' && <ReviewEditor key={post.id} post={post} runs={runs} />}
      {post.status === 'awaiting-approval' && <ToolApproval post={post} runs={runs} />}
      {post.status === 'revising' && <Revising post={post} />}
      {post.status === 'publishing' && <Publishing post={post} />}
      {post.status === 'published' && <Published post={post} />}
      {post.status === 'rejected' && <Rejected post={post} />}
      {(post.status === 'failed' || post.status === 'canceled') && <Failed post={post} />}
    </div>
  );
};
