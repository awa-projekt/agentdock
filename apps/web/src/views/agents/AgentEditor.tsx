import {
  AgentId,
  type AgentRecord,
  AgentSkillMode,
  type CreateAgentInput,
  type InputContract,
  type OutputContract,
  REASONING_EFFORT_LABELS,
  ReasoningEffort,
} from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { ChevronDown } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { AgentColorPicker } from '@/components/agent-color-picker';
import { Field, FormSection, Toggle } from '@/components/form';
import { isValidJsonSchemaValue, JsonSchemaEditor } from '@/components/json-schema-editor';
import { ModelPicker } from '@/components/model-picker';
import { ErrorBanner } from '@/components/StatusMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAgentDraft } from '@/hooks/use-agent-draft';
import { parseList, toErrorMessage } from '@/lib/format';
import { useCreateAgent, useModels, useSkills, useUpdateAgent } from '@/lib/queries';
import { agentsPath, providersPath } from '@/lib/routing';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@/views/agents/AgentIcon';

const DEFAULT_EFFORT = 'default';
const decodeReasoningEffort = Schema.decodeUnknownOption(ReasoningEffort);
const decodeSkillMode = Schema.decodeUnknownOption(AgentSkillMode);
const SKILL_MODE_ITEMS = [
  { value: 'on-demand', label: 'On demand' },
  { value: 'inject', label: 'Inject' },
] as const;

/** Create form when `agent` is null, otherwise the edit form for that agent. Rendered in the agents detail column. */
export function AgentEditor({ agent }: { agent: AgentRecord | null }) {
  const [, navigate] = useLocation();
  const [showA2a, setShowA2a] = useState(false);
  const { form, setForm, editingAgentId, editAgent, reset, setFocusProvider } = useAgentDraft();
  const skills = useSkills().data ?? [];
  const models = useModels().data ?? [];
  const reasoningEfforts = models.find((model) => model.value === form.model)?.reasoningEfforts ?? [];
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const saving = createAgent.isPending || updateAgent.isPending;
  const saveError = createAgent.error ?? updateAgent.error;
  const isEdit = agent !== null;

  useEffect(() => {
    if (agent && editingAgentId !== agent.id) editAgent(agent);
    if (!agent && editingAgentId !== null) reset();
  }, [agent, editAgent, editingAgentId, reset]);

  const update = (partial: Partial<CreateAgentInput>) => setForm({ ...form, ...partial });

  const cancel = () => {
    reset();
    navigate(agentsPath(agent?.id));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const onSuccess = (saved: AgentRecord) => {
      reset();
      navigate(agentsPath(saved.id));
    };
    if (agent) updateAgent.mutate({ agentId: agent.id, input: form }, { onSuccess });
    else createAgent.mutate(form, { onSuccess });
  };

  // An output contract exists only once a schema is entered; clearing the
  // schema drops the contract so no extension is advertised on the agent card.
  const updateInputContract = (partial: Partial<InputContract>) => {
    const next = {
      name: form.inputContract?.name ?? '',
      schema: form.inputContract?.schema ?? '',
      description: form.inputContract?.description,
      ...partial,
    };
    update({ inputContract: next.schema.trim() === '' ? undefined : next });
  };

  const updateOutputContract = (partial: Partial<OutputContract>) => {
    const next = {
      name: form.outputContract?.name ?? '',
      schema: form.outputContract?.schema ?? '',
      description: form.outputContract?.description,
      ...partial,
    };
    update({ outputContract: next.schema.trim() === '' ? undefined : next });
  };

  const inputSchemaValid = isValidJsonSchemaValue(form.inputContract?.schema ?? '');
  const outputSchemaValid = isValidJsonSchemaValue(form.outputContract?.schema ?? '');
  const schemaValid = inputSchemaValid && outputSchemaValid;

  return (
    <form onSubmit={submit} className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentIcon color={form.color ?? '#64748b'} className="size-11 rounded-lg" iconClassName="size-5" />
          <div className="min-w-0 space-y-1">
            <div className="truncate text-lg font-semibold">
              {form.name.trim() || (isEdit ? agent.name : 'New agent')}
            </div>
            <div className="text-xs text-muted-foreground">{isEdit ? 'Editing agent' : 'Not saved yet'}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !schemaValid}>
            {saving ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save agent' : 'Create agent'}
          </Button>
        </div>
      </div>

      {saveError ? <ErrorBanner>{toErrorMessage(saveError, 'Could not save the agent.')}</ErrorBanner> : null}
      <FormSection
        title="Identity"
        description="A clear name and description help you and other clients pick the right agent."
      >
        <Field label="Name" htmlFor="agent-name">
          <Input
            id="agent-name"
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="e.g. Research Assistant"
            required
          />
        </Field>

        <Field label="Description" htmlFor="agent-description">
          <Textarea
            id="agent-description"
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="What this agent does, in one or two sentences."
            className="min-h-20"
            required
          />
        </Field>

        {form.color ? (
          <Field
            label="Color"
            htmlFor="agent-color"
            description="Used for this agent and its outgoing paths in the communication graph."
          >
            <AgentColorPicker id="agent-color" value={form.color} onChange={(color) => update({ color })} />
          </Field>
        ) : null}
      </FormSection>

      <FormSection
        title="Configuration"
        description="How this agent runs: the model, instructions, and skills it executes with. Tools are managed in the Agent tools tab."
      >
        <Field label="Model" htmlFor="agent-model">
          <ModelPicker
            id="agent-model"
            value={form.model}
            onChange={(model) => update({ model, reasoningEffort: null })}
            onAddProviderKey={(provider) => {
              setFocusProvider(provider);
              navigate(providersPath());
            }}
          />
        </Field>

        {reasoningEfforts.length > 0 ? (
          <Field
            label="Reasoning effort"
            htmlFor="agent-reasoning-effort"
            description="How much the model thinks before answering. Default leaves it to the provider."
          >
            <Select
              value={form.reasoningEffort ?? DEFAULT_EFFORT}
              items={[
                { value: DEFAULT_EFFORT, label: 'Default' },
                ...reasoningEfforts.map((effort) => ({ value: effort, label: REASONING_EFFORT_LABELS[effort] })),
              ]}
              onValueChange={(value) => update({ reasoningEffort: Option.getOrNull(decodeReasoningEffort(value)) })}
            >
              <SelectTrigger id="agent-reasoning-effort" className="w-48">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_EFFORT}>Default</SelectItem>
                {reasoningEfforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {REASONING_EFFORT_LABELS[effort]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <Field label="Instructions" htmlFor="agent-instructions">
          <Textarea
            id="agent-instructions"
            value={form.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            placeholder="System prompt: tone, scope, do's and don'ts."
            className="min-h-36 font-mono text-sm"
            required
          />
        </Field>
        <Field
          label="Skills"
          htmlFor="agent-skills"
          description="Injected skills are part of every session's system prompt. On-demand skills are listed by description and loaded with the load_skill tool when a task matches."
        >
          <div className="grid gap-2 rounded-lg border border-border p-3">
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No global skills installed yet.</p>
            ) : (
              skills.map((skill) => {
                const mode = form.skills[skill.id];
                return (
                  <div key={skill.id} className="flex items-start gap-3 rounded-md p-2 hover:bg-muted/60">
                    <label className="flex min-w-0 flex-1 items-start gap-3">
                      <input
                        id="agent-skills"
                        type="checkbox"
                        className="mt-1"
                        checked={mode !== undefined}
                        onChange={(event) =>
                          update({
                            skills: event.target.checked
                              ? { ...form.skills, [skill.id]: 'on-demand' }
                              : Object.fromEntries(Object.entries(form.skills).filter(([id]) => id !== skill.id)),
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{skill.name}</span>
                        <span className="block text-xs text-muted-foreground">{skill.description}</span>
                      </span>
                    </label>
                    {mode === undefined ? null : (
                      <Select
                        value={mode}
                        items={SKILL_MODE_ITEMS}
                        onValueChange={(value) =>
                          Option.match(decodeSkillMode(value), {
                            onNone: () => undefined,
                            onSome: (next) => update({ skills: { ...form.skills, [skill.id]: next } }),
                          })
                        }
                      >
                        <SelectTrigger aria-label={`How ${skill.name} reaches the agent`} className="w-32 shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SKILL_MODE_ITEMS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Field>
      </FormSection>

      <div>
        <button
          type="button"
          aria-expanded={showA2a}
          onClick={() => setShowA2a((current) => !current)}
          className="flex w-full items-center gap-2 text-left"
        >
          <ChevronDown className={cn('size-4 transition-transform text-muted-foreground', showA2a && 'rotate-180')} />
          <span className="text-sm font-semibold">A2A interface</span>
          <span className="text-xs text-muted-foreground">
            How this agent is published and reached over the A2A protocol. Optional.
          </span>
        </button>

        {showA2a ? (
          <div className="mt-4 space-y-6 rounded-xl border border-border bg-muted/30 p-5">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Input modes" htmlFor="agent-input-modes" description="Comma-separated MIME types.">
                <Input
                  id="agent-input-modes"
                  value={form.defaultInputModes.join(', ')}
                  onChange={(event) => update({ defaultInputModes: [...parseList(event.target.value)] })}
                />
              </Field>
              <Field
                label="Output modes"
                htmlFor="agent-output-modes"
                description="Comma-separated MIME types advertised on the agent card."
              >
                <Input
                  id="agent-output-modes"
                  value={form.defaultOutputModes.join(', ')}
                  onChange={(event) => update({ defaultOutputModes: [...parseList(event.target.value)] })}
                />
              </Field>
              <Field
                label="Allowed agent IDs"
                htmlFor="agent-communication-targets"
                description="Comma-separated IDs this agent can message. Ignored when all agents are allowed."
              >
                <Input
                  id="agent-communication-targets"
                  value={form.communication.allowedAgentIds.join(', ')}
                  disabled={form.communication.allowAll}
                  onChange={(event) =>
                    update({
                      communication: {
                        ...form.communication,
                        allowedAgentIds: parseList(event.target.value).map((id) => AgentId.make(id)),
                      },
                    })
                  }
                />
              </Field>
            </div>

            <Toggle
              label="Can message all agents"
              description="Expose every other registered agent to this agent's communication tool."
              checked={form.communication.allowAll}
              onChange={(checked) => update({ communication: { ...form.communication, allowAll: checked } })}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle
                label="Streaming"
                description="Advertised on the agent card only — does not change runtime behavior yet."
                checked={form.capabilities.streaming}
                onChange={(checked) => update({ capabilities: { ...form.capabilities, streaming: checked } })}
              />
              <Toggle
                label="Push notifications"
                description="Advertised on the agent card only — does not change runtime behavior yet."
                checked={form.capabilities.pushNotifications}
                onChange={(checked) => update({ capabilities: { ...form.capabilities, pushNotifications: checked } })}
              />
            </div>

            <div className="space-y-4 border-t border-border/60 pt-5">
              <div>
                <p className="text-sm font-medium">Input contract</p>
                <p className="text-xs text-muted-foreground">
                  Define the JSON Schema this agent expects from A2A callers. Workflows use it to map only the declared
                  input fields. Leave the schema empty for free-form text input.
                </p>
              </div>
              <Field
                label="Contract name"
                htmlFor="agent-input-contract-name"
                description="A short identifier for the input shape, e.g. supportRequest."
              >
                <Input
                  id="agent-input-contract-name"
                  value={form.inputContract?.name ?? ''}
                  onChange={(event) => updateInputContract({ name: event.target.value })}
                  placeholder="supportRequest"
                />
              </Field>
              <Field
                label="Description"
                htmlFor="agent-input-contract-description"
                description="Optional. What callers should provide."
              >
                <Input
                  id="agent-input-contract-description"
                  value={form.inputContract?.description ?? ''}
                  onChange={(event) => updateInputContract({ description: event.target.value || undefined })}
                  placeholder="Fields required to process a support request."
                />
              </Field>
              <Field
                label="Input schema"
                htmlFor="agent-input-contract-schema"
                description="A visual JSON Schema editor for the structured input this agent accepts. Use Advanced JSON for unsupported schema keywords."
              >
                <JsonSchemaEditor
                  id="agent-input-contract-schema"
                  value={form.inputContract?.schema ?? ''}
                  onChange={(schema) => updateInputContract({ schema })}
                  emptyLabel="No input schema configured."
                  emptyDescription="Leave this empty for free-form text input, or add a schema for structured workflow mapping."
                />
                {!inputSchemaValid ? (
                  <p className="mt-1 text-xs text-destructive">The input schema is invalid.</p>
                ) : null}
              </Field>
            </div>

            <div className="space-y-4 border-t border-border/60 pt-5">
              <div>
                <p className="text-sm font-medium">Output contract</p>
                <p className="text-xs text-muted-foreground">
                  Define a JSON Schema to guarantee a structured final answer. The agent produces it as its response and
                  advertises it on the agent card so callers know what they get back. Leave the schema empty for
                  free-form text output.
                </p>
              </div>
              <Field
                label="Contract name"
                htmlFor="agent-output-contract-name"
                description="A short identifier for the output shape, e.g. invoiceExtraction."
              >
                <Input
                  id="agent-output-contract-name"
                  value={form.outputContract?.name ?? ''}
                  onChange={(event) => updateOutputContract({ name: event.target.value })}
                  placeholder="invoiceExtraction"
                />
              </Field>
              <Field
                label="Description"
                htmlFor="agent-output-contract-description"
                description="Optional. How the agent uses this output contract."
              >
                <Input
                  id="agent-output-contract-description"
                  value={form.outputContract?.description ?? ''}
                  onChange={(event) => updateOutputContract({ description: event.target.value || undefined })}
                  placeholder="Declares the structured invoice fields this agent returns."
                />
              </Field>
              <Field
                label="Output schema"
                htmlFor="agent-output-contract-schema"
                description="A visual JSON Schema editor for the structured final answer this agent returns."
              >
                <JsonSchemaEditor
                  id="agent-output-contract-schema"
                  value={form.outputContract?.schema ?? ''}
                  onChange={(schema) => updateOutputContract({ schema })}
                  emptyLabel="No output schema configured."
                  emptyDescription="Leave this empty for free-form text output, or add a schema to require structured final answers."
                />
                {!outputSchemaValid ? (
                  <p className="mt-1 text-xs text-destructive">The output schema is invalid.</p>
                ) : null}
              </Field>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border/60 pt-6">
        <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !schemaValid}>
          {saving ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save agent' : 'Create agent'}
        </Button>
      </div>
    </form>
  );
}
