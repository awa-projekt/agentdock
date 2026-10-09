import { isJsonObject, type Json, type JsonObject } from '../schemas/json';

export const inputRequiredRequestFromToolOutput = (json: Json): JsonObject | null => {
  if (!isJsonObject(json) || json.status !== 'input-required') {
    return null;
  }
  return isJsonObject(json.request) ? json.request : null;
};
