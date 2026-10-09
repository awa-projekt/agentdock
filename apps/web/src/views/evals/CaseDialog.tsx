import { decodeJsonObjectStringOption, type EvalCase, type EvalCaseInput } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import { type ReactNode, useState } from 'react';
import { Field } from '@/components/form';
import { JsonTextarea } from '@/components/json-textarea';
import { StatusMessage } from '@/components/StatusMessage';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseList } from '@/lib/format';

/** A case prefilled from elsewhere, e.g. a chat session turned into a test. */
export type CaseDraft = { readonly input: string; readonly expected: string };

/**
 * Creates or edits one case. `expected` is the reference answer graders
 * compare against; metadata is free-form JSON a grader can reference as
 * `{{metadata.<key>}}`, such as the tool a case expects to be called.
 */
export function CaseDialog({
  open,
  onOpenChange,
  evalCase,
  draft,
  pending,
  onSave,
  header,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evalCase: EvalCase | null;
  draft?: CaseDraft | undefined;
  pending: boolean;
  onSave: (input: EvalCaseInput) => void;
  /** Extra fields above the case, such as which dataset it goes into. */
  header?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? (
          <CaseForm
            evalCase={evalCase}
            draft={draft}
            header={header}
            pending={pending}
            onCancel={() => onOpenChange(false)}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CaseForm({
  evalCase,
  draft,
  header,
  pending,
  onCancel,
  onSave,
}: {
  evalCase: EvalCase | null;
  draft: CaseDraft | undefined;
  header: ReactNode;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: EvalCaseInput) => void;
}) {
  const [input, setInput] = useState(evalCase?.input ?? draft?.input ?? '');
  const [expected, setExpected] = useState(evalCase?.expected ?? draft?.expected ?? '');
  const [tags, setTags] = useState(evalCase?.tags.join(', ') ?? '');
  const [metadata, setMetadata] = useState(evalCase?.metadata ? JSON.stringify(evalCase.metadata, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmedMetadata = metadata.trim();
    const parsed = trimmedMetadata ? decodeJsonObjectStringOption(trimmedMetadata) : Option.none();
    if (trimmedMetadata && Option.isNone(parsed)) {
      setError('Metadata must be a JSON object.');
      return;
    }
    setError(null);
    onSave({
      input,
      expected: expected.length > 0 ? expected : undefined,
      tags: [...parseList(tags)],
      metadata: Option.getOrUndefined(parsed),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{evalCase ? 'Edit case' : 'New case'}</DialogTitle>
        <DialogDescription>
          Write the task so that two experts would independently agree whether an answer passes.
        </DialogDescription>
      </DialogHeader>
      {header}
      <Field label="Input" htmlFor="case-input" description="The message sent to the target.">
        <Textarea
          id="case-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="min-h-28 text-sm"
        />
      </Field>
      <Field
        label="Reference answer"
        htmlFor="case-expected"
        description="Optional. What a correct answer says; graders reference it as {{expected}}."
      >
        <Textarea
          id="case-expected"
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
          className="min-h-20 text-sm"
        />
      </Field>
      <Field
        label="Tags"
        htmlFor="case-tags"
        description="Comma-separated, e.g. regression, capability, refusal. Runs can filter by tag."
      >
        <Input id="case-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
      </Field>
      <Field label="Metadata" htmlFor="case-metadata" description="Optional JSON object, as {{metadata.<key>}}.">
        <JsonTextarea
          id="case-metadata"
          value={metadata}
          onChange={setMetadata}
          placeholder='{ "tool": "crm.lookup" }'
        />
      </Field>
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} disabled={pending || input.trim().length === 0}>
          {pending ? 'Saving…' : 'Save case'}
        </Button>
      </DialogFooter>
    </>
  );
}
