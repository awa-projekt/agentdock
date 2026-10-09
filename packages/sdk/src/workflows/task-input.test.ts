import { describe, expect, it } from 'vitest';
import type { InputContract } from '../schemas';
import {
  inputContractMediaTypes,
  validateTaskInput,
  type WorkflowInputPart,
  workflowInputFromParts,
  workflowInputMode,
} from './task-input';

const textPart = (text: string): WorkflowInputPart => ({ kind: 'text', text });
const filePart = (mimeType?: string): WorkflowInputPart => ({
  kind: 'file',
  file: { uri: 'https://example.com/file', name: 'file', mimeType },
});
const dataPart = (data: Extract<WorkflowInputPart, { readonly kind: 'data' }>['data']): WorkflowInputPart => ({
  kind: 'data',
  data,
});

const contract = (schema: string): InputContract => ({ name: 'input', schema });
const textContract = contract('{"type":"string","minLength":1}');
const orderContract = contract('{"type":"object","required":["orderId"],"properties":{"orderId":{"type":"string"}}}');
const imageContract = contract('{"type":"string","contentMediaType":"image/*"}');

describe('validateTaskInput', () => {
  it('accepts any task when no input contract is declared', () => {
    expect(validateTaskInput(undefined, [textPart('hello'), filePart('image/png')])).toEqual([]);
    expect(validateTaskInput(undefined, [])).toEqual([]);
  });

  it('validates text parts against string schemas', () => {
    expect(validateTaskInput(textContract, [textPart('hello')])).toEqual([]);
    expect(validateTaskInput(textContract, [textPart('')]).length).toBeGreaterThan(0);
    expect(validateTaskInput(textContract, [dataPart({ text: 'hello' })])[0]).toContain(
      'missing required input: a text part',
    );
  });

  it('validates data parts against object schemas', () => {
    expect(validateTaskInput(orderContract, [dataPart({ orderId: 'o-1' })])).toEqual([]);
    expect(validateTaskInput(orderContract, [dataPart({ name: 'no order id' })]).length).toBeGreaterThan(0);
    expect(validateTaskInput(orderContract, [textPart('hello')])[0]).toContain('missing required input: a data part');
  });

  it('matches file mime types from contentMediaType', () => {
    expect(validateTaskInput(imageContract, [filePart('image/png')])).toEqual([]);
    expect(
      validateTaskInput(imageContract, [filePart('application/pdf')]).some((issue) =>
        issue.includes("file type 'application/pdf' is not accepted"),
      ),
    ).toBe(true);
    expect(validateTaskInput(imageContract, [filePart()]).some((issue) => issue.includes('missing a mime type'))).toBe(
      true,
    );
  });

  it('flags invalid declared schemas instead of accepting silently', () => {
    const issues = validateTaskInput(contract('not json'), [dataPart({})]);
    expect(issues.some((issue) => issue.includes('not valid JSON'))).toBe(true);
  });
});

describe('workflowInputFromParts', () => {
  it('passes plain text through for string contracts', () => {
    expect(workflowInputMode(textContract)).toBe('text');
    expect(workflowInputFromParts(textContract, [textPart('hello'), textPart('world')])).toBe('hello\nworld');
  });

  // An undeclared contract accepts any task, so the content still has to reach
  // the workflow — dropping it would leave the entrypoint silently empty.
  it('forwards the task content when no input is declared, preferring data over text', () => {
    expect(workflowInputMode(undefined)).toBe('none');
    expect(workflowInputFromParts(undefined, [textPart('hello'), dataPart({ foo: 1 })])).toBe('{"foo":1}');
    expect(workflowInputFromParts(undefined, [textPart('hello')])).toBe('hello');
    expect(workflowInputFromParts(undefined, [])).toBe('');
  });

  it('exposes a data part as bare JSON for object contracts', () => {
    expect(workflowInputMode(orderContract)).toBe('data');
    expect(workflowInputFromParts(orderContract, [dataPart({ orderId: 'o-1' })])).toBe('{"orderId":"o-1"}');
  });

  it('summarizes file parts for file contracts', () => {
    expect(workflowInputMode(imageContract)).toBe('file');
    expect(JSON.parse(workflowInputFromParts(imageContract, [filePart('image/png')]))).toEqual({
      name: 'file',
      mimeType: 'image/png',
      uri: 'https://example.com/file',
    });
  });
});

describe('inputContractMediaTypes', () => {
  it('derives agent card media types from the contract', () => {
    expect(inputContractMediaTypes(undefined)).toEqual(['text/plain']);
    expect(inputContractMediaTypes(textContract)).toEqual(['text/plain']);
    expect(inputContractMediaTypes(orderContract)).toEqual(['application/json']);
    expect(inputContractMediaTypes(imageContract)).toEqual(['image/*']);
  });
});
