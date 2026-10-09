import type { Interrupt } from '@ag-ui/core';
import { z } from 'zod';
import { isJsonObject, type Json, jsonProperty, jsonString } from '../schemas/json';

const NativeInterrupt = z.object({ id: z.string(), value: z.json() });
export const interruptAddress = z.tuple([z.string(), z.string()]);

export const graphInterrupts = (taskId: string, payload: Json): Interrupt[] => {
  const raw = jsonProperty(payload, 'interrupts');
  const parsed = z.array(NativeInterrupt).safeParse(raw);
  const values =
    parsed.success && parsed.data.length > 0
      ? parsed.data
      : [{ id: jsonString(payload, 'actionId') ?? taskId, value: payload }];
  return values.map(({ id, value }) => {
    const responseSchema = jsonProperty(value, 'responseSchema');
    const entry = {
      id: JSON.stringify([taskId, id]),
      reason: 'input_required',
      message: jsonString(value, 'title') ?? jsonString(value, 'message') ?? 'Input required',
      metadata: { payload: value },
    };
    return isJsonObject(responseSchema) ? { ...entry, responseSchema } : entry;
  });
};
