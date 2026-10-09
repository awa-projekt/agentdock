import {
  detectEvalDatasetFileFormat,
  type EvalDatasetFileFormat,
  type EvalDatasetTable,
  type EvalFieldMapping,
  evalCasesFromTable,
  guessEvalFieldMapping,
  parseEvalDatasetFile,
} from 'agentdock-sdk/evals';
import type { EvalCaseInput } from 'agentdock-sdk/schemas';
import { Upload } from 'lucide-react';
import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { Field } from '@/components/form';
import { StatusMessage } from '@/components/StatusMessage';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { compactText, toErrorMessage } from '@/lib/format';

const NONE = '__none__';
const PREVIEW_ROWS = 5;

type Parsed =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'table'; readonly table: EvalDatasetTable };

const parse = (content: string, format: EvalDatasetFileFormat): Parsed => {
  if (content.trim().length === 0) return { kind: 'empty' };
  try {
    return { kind: 'table', table: parseEvalDatasetFile(content, format) };
  } catch (cause) {
    return { kind: 'error', message: toErrorMessage(cause, 'The file could not be read.') };
  }
};

/**
 * Imports cases from CSV, JSON or JSONL. Columns are mapped onto the input,
 * reference answer and tags; every other column is kept as metadata so graders
 * can still use it.
 */
export function ImportDialog({
  open,
  onOpenChange,
  intoDatasetName,
  pending,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when importing into an existing dataset; otherwise the import creates one. */
  intoDatasetName: string | null;
  pending: boolean;
  onImport: (cases: ReadonlyArray<EvalCaseInput>, newDatasetName: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {open ? (
          <ImportForm
            intoDatasetName={intoDatasetName}
            pending={pending}
            onCancel={() => onOpenChange(false)}
            onImport={onImport}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportForm({
  intoDatasetName,
  pending,
  onCancel,
  onImport,
}: {
  intoDatasetName: string | null;
  pending: boolean;
  onCancel: () => void;
  onImport: (cases: ReadonlyArray<EvalCaseInput>, newDatasetName: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [format, setFormat] = useState<EvalDatasetFileFormat>('jsonl');
  const [datasetName, setDatasetName] = useState('');
  const [mapping, setMapping] = useState<EvalFieldMapping | null>(null);
  const parsed = useMemo(() => parse(content, format), [content, format]);
  const columns = parsed.kind === 'table' ? parsed.table.columns : [];
  const activeMapping = mapping ?? guessEvalFieldMapping(columns);
  const cases = useMemo(
    () => (parsed.kind === 'table' ? evalCasesFromTable(parsed.table, activeMapping) : []),
    [parsed, activeMapping],
  );

  // Preview rows have no identity of their own; their position in the file is it.
  const preview = cases.slice(0, PREVIEW_ROWS).map((evalCase, position) => ({ id: `row-${position}`, evalCase }));

  const load = (text: string, fileName: string) => {
    setContent(text);
    setFormat(detectEvalDatasetFileFormat(fileName, text));
    setMapping(null);
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    load(await file.text(), file.name);
    if (!datasetName) setDatasetName(file.name.replace(/\.[^.]+$/, ''));
  };

  const mapTo = (field: keyof EvalFieldMapping) => (column: string) =>
    setMapping({ ...activeMapping, [field]: column === NONE ? undefined : column });

  const columnSelect = (field: keyof EvalFieldMapping, optional: boolean) => (
    <Select
      value={activeMapping[field] ?? NONE}
      items={[
        ...(optional ? [{ value: NONE, label: 'None' }] : []),
        ...columns.map((column) => ({ value: column, label: column })),
      ]}
      onValueChange={mapTo(field)}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {optional ? <SelectItem value={NONE}>None</SelectItem> : null}
        {columns.map((column) => (
          <SelectItem key={column} value={column}>
            {column}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{intoDatasetName ? `Import cases into ${intoDatasetName}` : 'Import a dataset'}</DialogTitle>
        <DialogDescription>
          CSV with a header row, a JSON array, or JSONL with one case per line. Our own export format (
          <code className="font-mono">input</code>, <code className="font-mono">expected</code>,{' '}
          <code className="font-mono">tags</code>, <code className="font-mono">metadata</code>) maps automatically.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"
          className="hidden"
          onChange={(event) => void readFile(event)}
        />
        <Button variant="outline" onClick={() => fileInput.current?.click()}>
          <Upload className="size-4" />
          Choose file
        </Button>
        <span className="text-xs text-muted-foreground">or paste below</span>
        <div className="ml-auto w-36">
          <Select
            value={format}
            items={{ jsonl: 'JSONL', json: 'JSON', csv: 'CSV / TSV' }}
            onValueChange={(next) => {
              setFormat(next);
              setMapping(null);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jsonl">JSONL</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv">CSV / TSV</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Textarea
        value={content}
        onChange={(event) => load(event.target.value, '')}
        placeholder={'{"input": "What is our refund window?", "expected": "30 days", "tags": ["policy"]}'}
        className="max-h-48 min-h-24 font-mono text-xs"
        spellCheck={false}
      />

      {parsed.kind === 'error' ? <StatusMessage kind="error">{parsed.message}</StatusMessage> : null}

      {parsed.kind === 'table' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Input column" htmlFor="map-input">
              {columnSelect('input', false)}
            </Field>
            <Field label="Reference answer column" htmlFor="map-expected">
              {columnSelect('expected', true)}
            </Field>
            <Field label="Tags column" htmlFor="map-tags">
              {columnSelect('tags', true)}
            </Field>
          </div>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Input</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map(({ id, evalCase }) => (
                  <TableRow key={id}>
                    <TableCell className="max-w-56 truncate text-xs">{compactText(evalCase.input, 80)}</TableCell>
                    <TableCell className="max-w-40 truncate text-xs">
                      {compactText(evalCase.expected ?? '', 60)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(evalCase.tags ?? []).map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {Object.keys(evalCase.metadata ?? {}).join(', ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {cases.length} case{cases.length === 1 ? '' : 's'} from {parsed.table.rows.length} row
            {parsed.table.rows.length === 1 ? '' : 's'}
            {cases.length < parsed.table.rows.length ? '; rows with an empty input are skipped' : ''}.
          </p>
        </>
      ) : null}

      {intoDatasetName ? null : (
        <Field label="Dataset name" htmlFor="import-name">
          <Input id="import-name" value={datasetName} onChange={(event) => setDatasetName(event.target.value)} />
        </Field>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={pending || cases.length === 0 || (!intoDatasetName && datasetName.trim().length === 0)}
          onClick={() => onImport(cases, datasetName.trim())}
        >
          {pending ? 'Importing…' : `Import ${cases.length} case${cases.length === 1 ? '' : 's'}`}
        </Button>
      </DialogFooter>
    </>
  );
}
