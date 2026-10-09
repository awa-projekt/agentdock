import type { DataPart, Part, TextPart } from '@a2a-js/sdk';
import * as Option from 'effect/Option';
import type { InputContract, Json, JsonObject, TriggerTaskTemplate } from '../schemas';
import { decodeJsonObjectStringOption, jsonProperty, renderJson } from '../schemas';
import { workflowInputMode } from '../workflows/task-input';

/** A trigger's event payload: an arbitrary JSON object placeholders resolve against. */
export type TriggerPayload = JsonObject;

const PLACEHOLDER = /\{\{\s*([\w.$]+)\s*\}\}/g;

const resolvePath = (payload: TriggerPayload, path: string): Json | undefined =>
  path === 'payload'
    ? payload
    : path.split('.').reduce<Json | undefined>((value, key) => jsonProperty(value, key), payload);

/** Render a text template: placeholders become strings (objects are JSON-encoded). */
export const renderTextTemplate = (template: string, payload: TriggerPayload): string =>
  template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = resolvePath(payload, path);
    return renderJson(value);
  });

/**
 * Render a data template: each placeholder expands to a JSON literal, so the
 * result is valid JSON, which is then decoded. A template that renders to
 * something other than a JSON object yields `{}`, since a2a data parts carry
 * objects.
 */
export const renderDataTemplate = (template: string, payload: TriggerPayload): JsonObject => {
  const json = template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = resolvePath(payload, path);
    return JSON.stringify(value === undefined ? null : value);
  });

  return Option.getOrElse(decodeJsonObjectStringOption(json), () => ({}));
};

/** Render a trigger's task template against an event payload into a2a parts. */
export const renderTriggerParts = (taskTemplate: TriggerTaskTemplate, payload: TriggerPayload): ReadonlyArray<Part> =>
  taskTemplate.parts.map(
    (part): Part =>
      part.kind === 'text'
        ? ({ kind: 'text', text: renderTextTemplate(part.text, payload) } satisfies TextPart)
        : ({
            kind: 'data',
            data: renderDataTemplate(part.template, payload),
          } satisfies DataPart),
  );

/**
 * Structural check of a trigger's task template against a target's declared
 * input contract, run at trigger create/update time. Unlike runtime input
 * validation this ignores content (no payload exists yet): it only checks that
 * every produced part kind is accepted and every required entry is covered.
 * Returns human-readable issues; an empty list means the template is valid. An
 * missing contract (or `undefined`, e.g. a free-form agent target) accepts any template.
 */
export const validateTriggerTemplate = (
  contract: InputContract | undefined,
  taskTemplate: TriggerTaskTemplate,
): ReadonlyArray<string> => {
  if (!contract?.schema.trim()) {
    return [];
  }

  const mode = workflowInputMode(contract);
  if (mode === 'none') return [];
  const acceptedKind = mode === 'text' ? 'text' : mode === 'data' ? 'data' : 'file';
  const issues: Array<string> = [];

  for (const part of taskTemplate.parts) {
    if (part.kind !== acceptedKind) {
      issues.push(`${part.kind} parts are not accepted by the target; it accepts: ${acceptedKind}`);
    }
  }

  if (!taskTemplate.parts.some((part) => part.kind === acceptedKind)) {
    issues.push(`the target requires a ${acceptedKind} part that the task template does not provide`);
  }

  return issues;
};
