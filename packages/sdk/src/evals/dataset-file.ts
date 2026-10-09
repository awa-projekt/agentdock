import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { EvalCase, EvalCaseInput } from '../schemas/evals';
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
  type Json,
  type JsonObject,
  type JsonObjectDraft,
  jsonProperty,
  renderJson,
} from '../schemas/json';

export type EvalDatasetFileFormat = 'jsonl' | 'json' | 'csv';

/** A parsed file: its column names in first-seen order and one record per row. */
export type EvalDatasetTable = {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<JsonObject>;
};

/**
 * Which columns become which case fields. Every column not mapped to
 * `input`, `expected` or `tags` lands in the case's metadata, so nothing in the
 * file is lost and graders can still reference it as `{{metadata.<column>}}`.
 */
export type EvalFieldMapping = {
  readonly input: string;
  readonly expected?: string | undefined;
  readonly tags?: string | undefined;
};

export class EvalDatasetFileError extends Schema.TaggedError<EvalDatasetFileError>()('EvalDatasetFileError', {
  message: Schema.String,
}) {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const detectEvalDatasetFileFormat = (fileName: string, content: string): EvalDatasetFileFormat => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  const trimmed = content.trimStart();
  if (trimmed.startsWith('[')) return 'json';
  return trimmed.startsWith('{') ? 'jsonl' : 'csv';
};

/** RFC 4180 CSV: quoted fields may hold separators, doubled quotes and line breaks. */
const parseCsvRecords = (content: string, separator: string): ReadonlyArray<ReadonlyArray<string>> => {
  const records: Array<Array<string>> = [];
  let record: Array<string> = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === separator) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((row) => row.some((cell) => cell.trim().length > 0));
};

const columnsOf = (rows: ReadonlyArray<JsonObject>): ReadonlyArray<string> => [
  ...new Set(rows.flatMap((row) => Object.keys(row))),
];

const parseCsv = (content: string, separator: string): EvalDatasetTable => {
  const [header, ...body] = parseCsvRecords(content, separator);
  if (!header) return { columns: [], rows: [] };
  const columns = header.map((column, index) => column.trim() || `column_${index + 1}`);
  const rows = body.map((cells) => {
    const row: JsonObjectDraft = {};
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? '';
    });
    return row;
  });
  return { columns, rows };
};

const requireObjects = (values: ReadonlyArray<Json>, where: (index: number) => string) =>
  values.map((value, index) => {
    if (!isJsonObject(value)) throw new EvalDatasetFileError({ message: `${where(index)} is not a JSON object.` });
    return value;
  });

/** Parses an uploaded file into rows; throws `EvalDatasetFileError` on malformed content. */
export const parseEvalDatasetFile = (content: string, format: EvalDatasetFileFormat): EvalDatasetTable => {
  switch (format) {
    case 'csv': {
      const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
      return parseCsv(content, firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',');
    }
    case 'json': {
      const parsed = Option.getOrUndefined(decodeJson(content));
      const items = isJsonArray(parsed) ? parsed : jsonProperty(parsed, 'cases');
      if (!isJsonArray(items)) {
        throw new EvalDatasetFileError({
          message: 'Expected a JSON array of cases, or an object with a `cases` array.',
        });
      }
      const rows = requireObjects(items, (index) => `Item ${index + 1}`);
      return { columns: columnsOf(rows), rows };
    }
    case 'jsonl': {
      const lines = content.split(/\r?\n/).flatMap((line, index) => (line.trim() ? [{ line, index }] : []));
      const values = lines.map(({ line, index }) => {
        const parsed = decodeJson(line);
        if (Option.isNone(parsed)) throw new EvalDatasetFileError({ message: `Line ${index + 1} is not valid JSON.` });
        return parsed.value;
      });
      const rows = requireObjects(values, (index) => `Line ${(lines[index]?.index ?? index) + 1}`);
      return { columns: columnsOf(rows), rows };
    }
  }
};

const INPUT_COLUMNS = ['input', 'question', 'prompt', 'query', 'message', 'task', 'instruction'];
const EXPECTED_COLUMNS = [
  'expected',
  'expected_output',
  'expectedoutput',
  'reference',
  'target',
  'answer',
  'ideal',
  'golden',
  'output',
];
const TAG_COLUMNS = ['tags', 'tag', 'labels', 'split'];

const findColumn = (columns: ReadonlyArray<string>, candidates: ReadonlyArray<string>): string | undefined =>
  candidates.flatMap((candidate) => columns.filter((column) => column.toLowerCase() === candidate))[0];

/** A best guess at the mapping from conventional column names; the first column stands in for a missing input. */
export const guessEvalFieldMapping = (columns: ReadonlyArray<string>): EvalFieldMapping => {
  const input = findColumn(columns, INPUT_COLUMNS) ?? columns[0] ?? 'input';
  const rest = columns.filter((column) => column !== input);
  return {
    input,
    expected: findColumn(rest, EXPECTED_COLUMNS),
    tags: findColumn(rest, TAG_COLUMNS),
  };
};

const cellText = (value: Json | undefined): string => renderJson(value);

const splitTags = (value: Json | undefined): ReadonlyArray<string> => {
  const items = isJsonArray(value) ? value.map(cellText) : cellText(value).split(/[,;|]/);
  return [...new Set(items.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
};

/** Turns parsed rows into cases; rows with an empty input are skipped. */
export const evalCasesFromTable = (table: EvalDatasetTable, mapping: EvalFieldMapping): ReadonlyArray<EvalCaseInput> =>
  table.rows.flatMap((row): ReadonlyArray<EvalCaseInput> => {
    const input = cellText(row[mapping.input]).trim();
    if (input.length === 0) return [];
    const metadata: JsonObjectDraft = {};
    for (const [column, value] of Object.entries(row)) {
      if (column === mapping.input || column === mapping.expected || column === mapping.tags) continue;
      // A nested `metadata` object (our own export format) merges in rather than nesting twice.
      if (column === 'metadata' && isJsonObject(value)) Object.assign(metadata, value);
      else if (!(isJsonString(value) && value.length === 0)) metadata[column] = value;
    }
    const expected = mapping.expected === undefined ? '' : cellText(row[mapping.expected]);
    const tags = mapping.tags === undefined ? [] : splitTags(row[mapping.tags]);
    const evalCase: EvalCaseInput = { input, tags };
    return [
      {
        ...evalCase,
        ...(expected.length === 0 ? undefined : { expected }),
        ...(Object.keys(metadata).length === 0 ? undefined : { metadata }),
      },
    ];
  });

/** One case per line in the shape `parseEvalDatasetFile` + `guessEvalFieldMapping` read back losslessly. */
export const evalCasesToJsonl = (cases: ReadonlyArray<EvalCase | EvalCaseInput>): string =>
  cases
    .map((evalCase) =>
      JSON.stringify({
        input: evalCase.input,
        expected: evalCase.expected,
        tags: evalCase.tags,
        metadata: evalCase.metadata,
      }),
    )
    .join('\n');
