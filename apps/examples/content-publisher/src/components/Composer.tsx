import { PenLine } from 'lucide-react';
import { useState } from 'react';
import type { Runs } from '../lib/useRuns';
import { Button, Spinner } from './ui';

export const Composer = ({ runs, disabled }: { runs: Runs; disabled: boolean }) => {
  const [brief, setBrief] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const text = brief.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setBrief('');
    try {
      await runs.newDraft(text);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-b border-slate-200 p-4">
      <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <PenLine className="size-3.5" /> New post
      </label>
      <textarea
        value={brief}
        disabled={disabled || submitting}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
        rows={3}
        placeholder="Describe the post you want. e.g. “A short, upbeat LinkedIn post announcing our new pricing tiers.”"
        className="w-full resize-none rounded-lg p-2.5 text-sm ring-1 ring-slate-200 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-400 disabled:bg-slate-50"
      />
      <Button onClick={submit} disabled={disabled || submitting || !brief.trim()} className="mt-2 w-full">
        {submitting ? <Spinner /> : <PenLine className="size-4" />}
        {submitting ? 'Drafting…' : 'Draft post'}
      </Button>
      {disabled && (
        <p className="mt-2 text-xs text-amber-600">
          Pick a workflow in the ⚙ settings panel (or set <code>WORKFLOW_ID</code>) to enable drafting.
        </p>
      )}
    </div>
  );
};
