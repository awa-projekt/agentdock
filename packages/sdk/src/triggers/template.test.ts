import { describe, expect, it } from 'vitest';
import type { InputContract, TriggerTaskTemplate } from '../schemas';
import { renderDataTemplate, renderTextTemplate, renderTriggerParts, validateTriggerTemplate } from './template';

const contract = (schema: string): InputContract => ({ name: 'input', schema });

describe('renderTextTemplate', () => {
  it('substitutes dot-path placeholders and stringifies objects', () => {
    expect(renderTextTemplate('Hi {{from}}', { from: 'a@b.com' })).toBe('Hi a@b.com');
    expect(renderTextTemplate('{{user.name}}', { user: { name: 'Bob' } })).toBe('Bob');
    expect(renderTextTemplate('all: {{payload}}', { a: 1 })).toBe('all: {"a":1}');
  });

  it('renders missing paths as empty strings', () => {
    expect(renderTextTemplate('x{{nope}}y', {})).toBe('xy');
  });
});

describe('renderDataTemplate', () => {
  it('expands placeholders as JSON literals before parsing', () => {
    const result = renderDataTemplate('{ "from": {{from}}, "all": {{payload}} }', { from: 'a@b.com', a: 1 });
    expect(result).toEqual({ from: 'a@b.com', all: { from: 'a@b.com', a: 1 } });
  });

  it('passes the whole payload through with a bare placeholder', () => {
    expect(renderDataTemplate('{{payload}}', { a: 1, b: [2, 3] })).toEqual({ a: 1, b: [2, 3] });
  });
});

describe('renderTriggerParts', () => {
  it('produces a2a text and data parts', () => {
    const template: TriggerTaskTemplate = {
      parts: [
        { kind: 'text', text: 'New mail from {{from}}' },
        { kind: 'data', template: '{ "subject": {{subject}} }' },
      ],
    };
    const parts = renderTriggerParts(template, { from: 'a@b.com', subject: 'Hello' });
    expect(parts).toEqual([
      { kind: 'text', text: 'New mail from a@b.com' },
      { kind: 'data', data: { subject: 'Hello' } },
    ]);
  });
});

describe('validateTriggerTemplate', () => {
  const textTemplate: TriggerTaskTemplate = { parts: [{ kind: 'text', text: 'hi' }] };

  it('accepts any template when the target declares no contract', () => {
    expect(validateTriggerTemplate(undefined, textTemplate)).toEqual([]);
  });

  it('rejects part kinds the target does not accept', () => {
    const issues = validateTriggerTemplate(contract('{"type":"object"}'), textTemplate);
    expect(issues.length).toBe(2);
    expect(issues[0]).toContain('text parts are not accepted');
  });

  it('flags a required input the template does not provide', () => {
    const issues = validateTriggerTemplate(contract('{"type":"object"}'), { parts: [] });
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('requires a data part');
  });

  it('accepts a template that satisfies the contract', () => {
    expect(validateTriggerTemplate(contract('{"type":"string"}'), textTemplate)).toEqual([]);
  });
});
