import { evalCasesToJsonl } from 'agentdock-sdk/evals';
import type { EvalCase, EvalCaseInput, EvalDataset, EvalDatasetDetail, EvalGraderId } from 'agentdock-sdk/schemas';
import { Download, Pencil, Play, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/form';
import { DetailSkeleton, ListSkeleton } from '@/components/Loading';
import { MasterDetail } from '@/components/MasterDetail';
import { SelectableCard } from '@/components/SelectableCard';
import { ErrorBanner, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { compactText, formatDateTime, toErrorMessage } from '@/lib/format';
import {
  useAddEvalCases,
  useCreateEvalDataset,
  useEvalDataset,
  useEvalDatasets,
  useEvalGraders,
  useRemoveEvalCases,
  useRemoveEvalDataset,
  useUpdateEvalCase,
  useUpdateEvalDataset,
} from '@/lib/queries';
import { CaseDialog } from '@/views/evals/CaseDialog';
import { GateDialog } from '@/views/evals/GateDialog';
import { GraderPicker } from '@/views/evals/GraderPicker';
import { ImportDialog } from '@/views/evals/ImportDialog';
import { NewRunDialog } from '@/views/evals/NewRunDialog';

const downloadText = (fileName: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

export function DatasetsTab({
  datasetId,
  onSelectDataset,
  onRunStarted,
}: {
  datasetId: string | null;
  onSelectDataset: (datasetId: string | null) => void;
  onRunStarted: (runId: string) => void;
}) {
  const datasetsQuery = useEvalDatasets();
  const createDataset = useCreateEvalDataset();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datasets = datasetsQuery.data ?? [];
  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    if (!search) return datasets;
    return datasets.filter((dataset) =>
      [dataset.name, dataset.description, ...dataset.tags].join('\n').toLowerCase().includes(search),
    );
  }, [datasets, deferredQuery]);
  const selected = datasets.find((dataset) => dataset.id === datasetId) ?? filtered[0] ?? null;

  const importDataset = (cases: ReadonlyArray<EvalCaseInput>, name: string) => {
    setError(null);
    createDataset.mutate(
      { name, description: '', graderIds: [], cases: [...cases] },
      {
        onSuccess: (dataset) => {
          setImporting(false);
          onSelectDataset(dataset.id);
        },
        onError: (cause) => setError(toErrorMessage(cause, 'Could not import the dataset.')),
      },
    );
  };

  return (
    <>
      <MasterDetail
        masterWidth="340px"
        master={
          <>
            <div className="flex gap-2">
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                New dataset
              </Button>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload className="size-4" />
                Import
              </Button>
            </div>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search datasets" />
            {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
            {datasetsQuery.isError ? (
              <ErrorBanner>{toErrorMessage(datasetsQuery.error, 'Could not load datasets.')}</ErrorBanner>
            ) : datasetsQuery.isPending ? (
              <ListSkeleton compact />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="No datasets"
                description="Start with 20 to 50 tasks drawn from real failures. Import a file, write cases by hand, or add them from chat sessions."
              />
            ) : (
              <div className="space-y-2">
                {filtered.map((dataset) => (
                  <SelectableCard
                    key={dataset.id}
                    active={selected?.id === dataset.id}
                    onClick={() => onSelectDataset(dataset.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="truncate text-sm font-semibold">{dataset.name}</div>
                      <Badge variant="outline">{dataset.caseCount} cases</Badge>
                    </div>
                    {dataset.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{dataset.description}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {dataset.tags.slice(0, 6).map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </SelectableCard>
                ))}
              </div>
            )}
          </>
        }
        detail={
          datasetsQuery.isPending ? (
            <DetailSkeleton />
          ) : selected ? (
            <DatasetDetail
              key={selected.id}
              datasetId={selected.id}
              onDeleted={() => onSelectDataset(null)}
              onRunStarted={onRunStarted}
            />
          ) : (
            <EmptyState title="Select a dataset" description="Pick a dataset to view and edit its cases." />
          )
        }
      />
      <DatasetDialog
        open={creating}
        onOpenChange={setCreating}
        dataset={null}
        onSaved={(dataset) => onSelectDataset(dataset.id)}
      />
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        intoDatasetName={null}
        pending={createDataset.isPending}
        onImport={importDataset}
      />
    </>
  );
}

function DatasetDetail({
  datasetId,
  onDeleted,
  onRunStarted,
}: {
  datasetId: string;
  onDeleted: () => void;
  onRunStarted: (runId: string) => void;
}) {
  const detailQuery = useEvalDataset(datasetId);
  const graders = useEvalGraders().data ?? [];
  const removeDataset = useRemoveEvalDataset();
  const addCases = useAddEvalCases();
  const updateCase = useUpdateEvalCase();
  const removeCases = useRemoveEvalCases();
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [guarding, setGuarding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [caseDialog, setCaseDialog] = useState<{ readonly evalCase: EvalCase | null } | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlyArray<string>>([]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [error, setError] = useState<string | null>(null);

  const cases = detailQuery.data?.cases ?? [];
  const visible = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return cases.filter(
      (evalCase) =>
        (tagFilter === null || evalCase.tags.includes(tagFilter)) &&
        (!search || `${evalCase.input}\n${evalCase.expected ?? ''}`.toLowerCase().includes(search)),
    );
  }, [cases, deferredQuery, tagFilter]);

  if (detailQuery.isPending) return <DetailSkeleton />;
  if (detailQuery.isError) {
    return <ErrorBanner>{toErrorMessage(detailQuery.error, 'Could not load the dataset.')}</ErrorBanner>;
  }
  const { dataset } = detailQuery.data;
  const defaultGraders = graders.filter((grader) => dataset.graderIds.includes(grader.id));
  const allVisibleSelected = visible.length > 0 && visible.every((evalCase) => selectedIds.includes(evalCase.id));
  const fail = (fallback: string) => (cause: Error) => setError(toErrorMessage(cause, fallback));

  const saveCase = (input: EvalCaseInput) => {
    setError(null);
    const existing = caseDialog?.evalCase;
    const close = { onSuccess: () => setCaseDialog(null), onError: fail('Could not save the case.') };
    if (existing) updateCase.mutate({ datasetId, caseId: existing.id, input }, close);
    else addCases.mutate({ datasetId, input: { cases: [input] } }, close);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">{dataset.name}</h2>
          {dataset.description ? <p className="mt-1 text-sm text-muted-foreground">{dataset.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Default graders:</span>
            {defaultGraders.length === 0 ? (
              <span>none</span>
            ) : (
              defaultGraders.map((grader) => (
                <Badge key={grader.id} variant="secondary">
                  {grader.name}
                </Badge>
              ))
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Updated {formatDateTime(dataset.updatedAt)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={() => setRunning(true)} disabled={dataset.caseCount === 0}>
            <Play className="size-4" />
            Run
          </Button>
          <Button variant="outline" onClick={() => setGuarding(true)} disabled={dataset.caseCount === 0}>
            <ShieldCheck className="size-4" />
            Guard an agent
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadText(`${dataset.name.replace(/[^\w-]+/g, '-')}.jsonl`, evalCasesToJsonl(cases))}
            disabled={cases.length === 0}
          >
            <Download className="size-4" />
            Export
          </Button>
          <ConfirmButton
            variant="destructiveGhost"
            size="icon"
            title="Delete dataset"
            description={`Delete "${dataset.name}" and its ${dataset.caseCount} cases? Past runs keep their results.`}
            confirmLabel="Delete"
            disabled={removeDataset.isPending}
            onConfirm={() =>
              removeDataset.mutate(datasetId, { onSuccess: onDeleted, onError: fail('Could not delete the dataset.') })
            }
          >
            <Trash2 className="size-4" />
          </ConfirmButton>
        </div>
      </div>

      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search cases"
          className="max-w-64"
        />
        <div className="flex flex-wrap gap-1">
          {dataset.tags.map((tag) => (
            <button key={tag} type="button" onClick={() => setTagFilter(tagFilter === tag ? null : tag)}>
              <Badge variant={tagFilter === tag ? 'default' : 'outline'}>{tag}</Badge>
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {selectedIds.length > 0 ? (
            <ConfirmButton
              variant="outline"
              title="Delete cases"
              description={`Delete ${selectedIds.length} selected case${selectedIds.length === 1 ? '' : 's'}?`}
              confirmLabel="Delete"
              disabled={removeCases.isPending}
              onConfirm={() =>
                removeCases.mutate(
                  { datasetId, caseIds: selectedIds },
                  { onSuccess: () => setSelectedIds([]), onError: fail('Could not delete the cases.') },
                )
              }
            >
              <Trash2 className="size-4" />
              Delete {selectedIds.length}
            </ConfirmButton>
          ) : null}
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload className="size-4" />
            Import cases
          </Button>
          <Button variant="outline" onClick={() => setCaseDialog({ evalCase: null })}>
            <Plus className="size-4" />
            Add case
          </Button>
        </div>
      </div>

      {cases.length === 0 ? (
        <EmptyState
          title="No cases yet"
          description="Add cases where the behavior should happen and cases where it should not, so the suite does not reward one-sided behavior."
        />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelectedIds(
                        allVisibleSelected
                          ? selectedIds.filter((id) => !visible.some((evalCase) => evalCase.id === id))
                          : [...new Set([...selectedIds, ...visible.map((evalCase) => evalCase.id)])],
                      )
                    }
                    className="size-3.5 accent-[var(--primary)]"
                  />
                </TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Reference answer</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((evalCase) => (
                <TableRow key={evalCase.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label="Select case"
                      checked={selectedIds.includes(evalCase.id)}
                      onChange={() =>
                        setSelectedIds(
                          selectedIds.includes(evalCase.id)
                            ? selectedIds.filter((id) => id !== evalCase.id)
                            : [...selectedIds, evalCase.id],
                        )
                      }
                      className="size-3.5 accent-[var(--primary)]"
                    />
                  </TableCell>
                  <TableCell className="max-w-80">
                    <button
                      type="button"
                      className="block w-full truncate text-left text-xs hover:underline"
                      onClick={() => setCaseDialog({ evalCase })}
                    >
                      {compactText(evalCase.input, 120)}
                    </button>
                    {evalCase.metadata ? (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {Object.keys(evalCase.metadata).join(', ')}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                    {evalCase.expected ? compactText(evalCase.expected, 90) : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {evalCase.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit case"
                      onClick={() => setCaseDialog({ evalCase })}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <DatasetDialog open={editing} onOpenChange={setEditing} dataset={detailQuery.data} onSaved={() => undefined} />
      <CaseDialog
        open={caseDialog !== null}
        onOpenChange={(open) => (open ? undefined : setCaseDialog(null))}
        evalCase={caseDialog?.evalCase ?? null}
        pending={addCases.isPending || updateCase.isPending}
        onSave={saveCase}
      />
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        intoDatasetName={dataset.name}
        pending={addCases.isPending}
        onImport={(imported) =>
          addCases.mutate(
            { datasetId, input: { cases: [...imported] } },
            { onSuccess: () => setImporting(false), onError: fail('Could not import the cases.') },
          )
        }
      />
      <NewRunDialog open={running} onOpenChange={setRunning} initialDatasetId={datasetId} onStarted={onRunStarted} />
      <GateDialog open={guarding} onOpenChange={setGuarding} gate={null} initialDatasetId={datasetId} />
    </div>
  );
}

/** Creates a dataset, or edits the name, description and default graders of one. */
function DatasetDialog({
  open,
  onOpenChange,
  dataset,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataset: EvalDatasetDetail | null;
  onSaved: (dataset: EvalDataset) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <DatasetForm dataset={dataset} onClose={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DatasetForm({
  dataset,
  onClose,
  onSaved,
}: {
  dataset: EvalDatasetDetail | null;
  onClose: () => void;
  onSaved: (dataset: EvalDataset) => void;
}) {
  const graders = useEvalGraders().data ?? [];
  const createDataset = useCreateEvalDataset();
  const updateDataset = useUpdateEvalDataset();
  const [name, setName] = useState(dataset?.dataset.name ?? '');
  const [description, setDescription] = useState(dataset?.dataset.description ?? '');
  const [graderIds, setGraderIds] = useState<ReadonlyArray<EvalGraderId>>(dataset?.dataset.graderIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const pending = createDataset.isPending || updateDataset.isPending;

  const save = () => {
    setError(null);
    const input = { name, description, graderIds: [...graderIds] };
    const handlers = {
      onSuccess: (saved: EvalDataset) => {
        onClose();
        onSaved(saved);
      },
      onError: (cause: Error) => setError(toErrorMessage(cause, 'Could not save the dataset.')),
    };
    if (dataset) updateDataset.mutate({ datasetId: dataset.dataset.id, input }, handlers);
    else createDataset.mutate(input, handlers);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dataset ? 'Edit dataset' : 'New dataset'}</DialogTitle>
        <DialogDescription>
          A dataset is a suite of tasks; tags inside it split it into smaller suites.
        </DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor="dataset-name">
        <Input id="dataset-name" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Description" htmlFor="dataset-description">
        <Textarea
          id="dataset-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-16 text-sm"
          placeholder="What capability this suite measures, and where its cases come from."
        />
      </Field>
      <Field label="Default graders" htmlFor="dataset-graders" description="Pre-selected when you start a run.">
        <GraderPicker graders={graders} selected={graderIds} onChange={setGraderIds} />
      </Field>
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={pending || name.trim().length === 0}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}
