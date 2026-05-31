import { createDefaultA2aCommunicationTools, defaultA2aCommunicationTools } from './a2a';
import { createSkillTools } from './skills';

export const defaultTools = {
  ...defaultA2aCommunicationTools,
};

export const createDefaultTools = (sourceAgentId?: string) => ({
  ...createDefaultA2aCommunicationTools(sourceAgentId ? { sourceAgentId } : {}),
  ...createSkillTools(sourceAgentId ? { sourceAgentId } : {}),
});
