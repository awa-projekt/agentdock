import type { AgentRecord, CreateAgentInput } from 'agentdock-sdk/schemas';
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { agentToForm, createDefaultForm } from '@/lib/agent-form';
import { agentEditorPattern, providersPath } from '@/lib/routing';

type AgentDraft = {
  readonly form: CreateAgentInput;
  readonly editingAgentId: string | null;
  readonly focusProvider: string | null;
  readonly setForm: (form: CreateAgentInput) => void;
  readonly editAgent: (agent: AgentRecord) => void;
  readonly reset: () => void;
  readonly setFocusProvider: (provider: string | null) => void;
};

const AgentDraftContext = createContext<AgentDraft | null>(null);

/**
 * Holds the in-progress agent form outside the editor so it survives the
 * detour to Providers that the model picker offers; any other navigation
 * discards it.
 */
export function AgentDraftProvider({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [form, setForm] = useState<CreateAgentInput>(createDefaultForm);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [focusProvider, setFocusProvider] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (active && !agentEditorPattern.test(location) && location !== providersPath()) {
      setForm(createDefaultForm());
      setEditingAgentId(null);
      setActive(false);
    }
  }, [active, location]);

  const value = useMemo<AgentDraft>(
    () => ({
      form,
      editingAgentId,
      focusProvider,
      setForm: (next) => {
        setForm(next);
        setActive(true);
      },
      editAgent: (agent) => {
        setForm(agentToForm(agent));
        setEditingAgentId(agent.id);
        setActive(true);
      },
      reset: () => {
        setForm(createDefaultForm());
        setEditingAgentId(null);
        setActive(false);
      },
      setFocusProvider,
    }),
    [editingAgentId, focusProvider, form],
  );

  return <AgentDraftContext value={value}>{children}</AgentDraftContext>;
}

export function useAgentDraft(): AgentDraft {
  const draft = use(AgentDraftContext);
  if (!draft) throw new Error('useAgentDraft must be used inside an AgentDraftProvider.');
  return draft;
}
