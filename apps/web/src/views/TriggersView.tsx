import { randomUUIDv4 } from 'agentdock-sdk/random';
import type { CreateTriggerInput, Trigger, TriggerSpec } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import { Clock, Globe, Mail, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field, FormSection, Toggle } from '@/components/form';
import { JsonTextarea } from '@/components/json-textarea';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { triggerWebhookUrl } from '@/lib/api';
import { formatDateTime, toErrorMessage } from '@/lib/format';
import { useAddTrigger, useAgents, useRemoveTrigger, useTriggers, useUpdateTrigger, useWorkflows } from '@/lib/queries';

type SpecType = TriggerSpec['type'];
type TargetKind = 'agent' | 'workflow';
type PartKind = 'text' | 'data';

type PartDraft = { kind: PartKind; value: string };

type TriggerForm = {
  name: string;
  enabled: boolean;
  targetKind: TargetKind;
  targetId: string;
  specType: SpecType;
  cron: string;
  timezone: string;
  secret: string;
  mailbox: string;
  matchFrom: string;
  matchSubject: string;
  parts: ReadonlyArray<PartDraft>;
};

const CRON_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 08:00', cron: '0 8 * * 1-5' },
];

const SPEC_META = {
  schedule: { label: 'Schedule', icon: Clock },
  webhook: { label: 'Webhook', icon: Globe },
  email: { label: 'Email', icon: Mail },
} satisfies Record<SpecType, { label: string; icon: typeof Clock }>;

const randomSecret = (): string => Effect.runSync(randomUUIDv4).replaceAll('-', '');

const emptyForm = (): TriggerForm => ({
  name: '',
  enabled: true,
  targetKind: 'agent',
  targetId: '',
  specType: 'schedule',
  cron: '*/5 * * * *',
  timezone: '',
  secret: randomSecret(),
  mailbox: '',
  matchFrom: '',
  matchSubject: '',
  parts: [{ kind: 'text', value: '' }],
});

const triggerToForm = (trigger: Trigger): TriggerForm => {
  const spec = trigger.spec;
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    targetKind: trigger.target.kind,
    targetId: trigger.target.id,
    specType: spec.type,
    cron: spec.type === 'schedule' ? spec.cron : '*/5 * * * *',
    timezone: spec.type === 'schedule' ? (spec.timezone ?? '') : '',
    secret: spec.type === 'webhook' ? spec.secret : randomSecret(),
    mailbox: spec.type === 'email' ? spec.mailbox : '',
    matchFrom: spec.type === 'email' ? (spec.match?.from ?? '') : '',
    matchSubject: spec.type === 'email' ? (spec.match?.subjectContains ?? '') : '',
    parts: trigger.taskTemplate.parts.map((part) =>
      part.kind === 'text'
        ? { kind: 'text' as const, value: part.text }
        : { kind: 'data' as const, value: part.template },
    ),
  };
};

const buildSpec = (form: TriggerForm): TriggerSpec => {
  switch (form.specType) {
    case 'schedule':
      return {
        type: 'schedule',
        cron: form.cron.trim(),
        timezone: form.timezone.trim() || undefined,
      };
    case 'webhook':
      return { type: 'webhook', secret: form.secret.trim() };
    case 'email': {
      const from = form.matchFrom.trim();
      const subjectContains = form.matchSubject.trim();
      return {
        type: 'email',
        mailbox: form.mailbox.trim(),
        match:
          from || subjectContains
            ? { from: from || undefined, subjectContains: subjectContains || undefined }
            : undefined,
      };
    }
  }
};

const buildInput = (form: TriggerForm): CreateTriggerInput => ({
  name: form.name.trim(),
  enabled: form.enabled,
  target: { kind: form.targetKind, id: form.targetId },
  taskTemplate: {
    parts: form.parts.map((part) =>
      part.kind === 'text'
        ? { kind: 'text' as const, text: part.value }
        : { kind: 'data' as const, template: part.value },
    ),
  },
  spec: buildSpec(form),
});

export function TriggersView() {
  const triggersQuery = useTriggers();
  const triggers = triggersQuery.data ?? [];
  const agents = useAgents().data ?? [];
  const workflows = useWorkflows().data ?? [];
  const addTrigger = useAddTrigger();
  const updateTrigger = useUpdateTrigger();
  const removeTrigger = useRemoveTrigger();
  const busy = addTrigger.isPending || updateTrigger.isPending || removeTrigger.isPending;
  const [form, setForm] = useState<TriggerForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<FeedbackMessage | null>(null);

  // Agents carry their name directly; a workflow's lives in its manifest.
  const targetOptions: ReadonlyArray<{ readonly id: string; readonly name: string }> =
    form.targetKind === 'agent'
      ? agents.map((agent) => ({ id: agent.id, name: agent.name }))
      : workflows.map((workflow) => ({ id: workflow.id, name: workflow.manifest.name }));
  const targetName = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const agent of agents) lookup.set(`agent:${agent.id}`, agent.name);
    for (const workflow of workflows) lookup.set(`workflow:${workflow.id}`, workflow.manifest.name);
    return (target: Trigger['target']) => lookup.get(`${target.kind}:${target.id}`) ?? target.id;
  }, [agents, workflows]);

  const patch = (next: Partial<TriggerForm>) => setForm((current) => ({ ...current, ...next }));

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
  };

  const startEdit = (trigger: Trigger) => {
    setForm(triggerToForm(trigger));
    setEditingId(trigger.id);
    setMessage(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const updatePart = (index: number, next: Partial<PartDraft>) =>
    setForm((current) => ({
      ...current,
      parts: current.parts.map((part, i) => (i === index ? { ...part, ...next } : part)),
    }));

  const addPart = (kind: PartKind) =>
    setForm((current) => ({ ...current, parts: [...current.parts, { kind, value: '' }] }));

  const removePart = (index: number) =>
    setForm((current) => ({ ...current, parts: current.parts.filter((_, i) => i !== index) }));

  const canSubmit =
    form.name.trim().length > 0 &&
    form.targetId.length > 0 &&
    (form.specType === 'schedule'
      ? form.cron.trim().length > 0
      : form.specType === 'webhook'
        ? form.secret.trim().length > 0
        : form.mailbox.trim().length > 0);

  const fail = (fallback: string) => (error: Error) =>
    setMessage({ kind: 'error' as const, text: toErrorMessage(error, fallback) });

  const submit = () => {
    setMessage(null);
    const input = buildInput(form);
    const onSuccess = (text: string) => () => {
      setMessage({ kind: 'success', text });
      resetForm();
    };
    if (editingId) {
      updateTrigger.mutate(
        { triggerId: editingId, input },
        { onSuccess: onSuccess('Trigger updated.'), onError: fail('Failed to save trigger.') },
      );
    } else {
      addTrigger.mutate(input, { onSuccess: onSuccess('Trigger created.'), onError: fail('Failed to save trigger.') });
    }
  };

  const deleteTrigger = (triggerId: string) => {
    setMessage(null);
    removeTrigger.mutate(triggerId, {
      onSuccess: () => {
        if (editingId === triggerId) resetForm();
        setMessage({ kind: 'success', text: 'Trigger deleted.' });
      },
      onError: fail('Failed to delete trigger.'),
    });
  };

  const toggleEnabled = (trigger: Trigger) => {
    setMessage(null);
    updateTrigger.mutate(
      { triggerId: trigger.id, input: { ...triggerInput(trigger), enabled: !trigger.enabled } },
      { onError: fail('Failed to update trigger.') },
    );
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Triggers"
        description="Fire agents and workflows automatically on a schedule, an inbound webhook, or new mail."
      />
      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}
      {triggersQuery.isError ? (
        <StatusMessage kind="error">{toErrorMessage(triggersQuery.error, 'Could not load triggers.')}</StatusMessage>
      ) : null}

      <FormSection
        title={editingId ? 'Edit Trigger' : 'New Trigger'}
        description="A trigger renders an a2a task from its template and sends it to the target. Use {{payload}} or {{path}} placeholders to inject event data."
      >
        <div className="space-y-5">
          <Field label="Name" htmlFor="trigger-name">
            <Input
              id="trigger-name"
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Nightly report"
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Target type" htmlFor="trigger-target-kind">
              <Select
                value={form.targetKind}
                items={{ agent: 'Agent', workflow: 'Workflow' }}
                onValueChange={(value) => patch({ targetKind: value, targetId: '' })}
              >
                <SelectTrigger id="trigger-target-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="workflow">Workflow</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Target" htmlFor="trigger-target-id">
              <Select
                value={form.targetId}
                items={targetOptions.map((option) => ({ value: option.id, label: option.name }))}
                onValueChange={(value) => patch({ targetId: value })}
              >
                <SelectTrigger id="trigger-target-id" className="w-full">
                  <SelectValue placeholder={`Select ${form.targetKind}…`} />
                </SelectTrigger>
                <SelectContent>
                  {targetOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Type" htmlFor="trigger-spec-type">
            <Select
              value={form.specType}
              items={{ schedule: 'Schedule (cron)', webhook: 'Webhook', email: 'Email (Microsoft 365)' }}
              onValueChange={(value) => patch({ specType: value })}
            >
              <SelectTrigger id="trigger-spec-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="schedule">Schedule (cron)</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
                <SelectItem value="email">Email (Microsoft 365)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {form.specType === 'schedule' ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <Field
                label="Cron expression"
                htmlFor="trigger-cron"
                description="Standard 5-field cron: minute hour day-of-month month day-of-week."
              >
                <Input
                  id="trigger-cron"
                  value={form.cron}
                  onChange={(event) => patch({ cron: event.target.value })}
                  placeholder="*/5 * * * *"
                  className="font-mono"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset.cron}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => patch({ cron: preset.cron })}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <Field
                label="Timezone"
                htmlFor="trigger-timezone"
                description="IANA name (e.g. Europe/Berlin). Leave empty for UTC."
              >
                <Input
                  id="trigger-timezone"
                  value={form.timezone}
                  onChange={(event) => patch({ timezone: event.target.value })}
                  placeholder="Europe/Berlin"
                />
              </Field>
            </div>
          ) : null}

          {form.specType === 'webhook' ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <Field
                label="Secret"
                htmlFor="trigger-secret"
                description="Send this as the authentication secret when calling the webhook."
              >
                <div className="flex gap-2">
                  <Input
                    id="trigger-secret"
                    value={form.secret}
                    onChange={(event) => patch({ secret: event.target.value })}
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => patch({ secret: randomSecret() })}>
                    Generate
                  </Button>
                </div>
              </Field>
              {editingId ? (
                <p className="break-all text-xs text-muted-foreground">
                  Endpoint: <span className="font-mono">POST {triggerWebhookUrl(editingId)}</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">The webhook URL is shown after the trigger is created.</p>
              )}
            </div>
          ) : null}

          {form.specType === 'email' ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <Field
                label="Mailbox"
                htmlFor="trigger-mailbox"
                description="Primary SMTP address of the monitored Microsoft 365 mailbox."
              >
                <Input
                  id="trigger-mailbox"
                  value={form.mailbox}
                  onChange={(event) => patch({ mailbox: event.target.value })}
                  placeholder="inbox@example.com"
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="From contains" htmlFor="trigger-match-from" description="Optional sender filter.">
                  <Input
                    id="trigger-match-from"
                    value={form.matchFrom}
                    onChange={(event) => patch({ matchFrom: event.target.value })}
                    placeholder="alerts@vendor.com"
                  />
                </Field>
                <Field label="Subject contains" htmlFor="trigger-match-subject" description="Optional subject filter.">
                  <Input
                    id="trigger-match-subject"
                    value={form.matchSubject}
                    onChange={(event) => patch({ matchSubject: event.target.value })}
                    placeholder="[invoice]"
                  />
                </Field>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Task template</div>
                <div className="text-xs text-muted-foreground">
                  The a2a message parts sent on fire. Leave empty for targets that take no input.
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => addPart('text')}>
                  <Plus className="size-3.5" /> Text
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => addPart('data')}>
                  <Plus className="size-3.5" /> Data
                </Button>
              </div>
            </div>
            {form.parts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                No parts. The target will receive an empty task.
              </p>
            ) : null}
            {form.parts.map((part, index) => (
              <div key={index} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <Badge variant="secondary">{part.kind === 'text' ? 'Text' : 'Data (JSON)'}</Badge>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="destructiveGhost"
                    onClick={() => removePart(index)}
                    title="Remove part"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <JsonTextarea
                  value={part.value}
                  onChange={(value) => updatePart(index, { value })}
                  format={part.kind === 'data'}
                  placeholder={
                    part.kind === 'text' ? 'Run the daily report. Subject: {{subject}}' : '{ "payload": {{payload}} }'
                  }
                />
              </div>
            ))}
          </div>

          <Toggle
            label="Enabled"
            description="Disabled triggers stay configured but never fire."
            checked={form.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />

          <div className="flex gap-2">
            <Button type="button" onClick={submit} disabled={busy || !canSubmit}>
              {editingId ? 'Save changes' : 'Create trigger'}
            </Button>
            {editingId ? (
              <Button type="button" variant="ghost" onClick={resetForm} disabled={busy}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </FormSection>

      <FormSection title="Configured Triggers" description="All triggers across agents and workflows.">
        {triggersQuery.isPending ? <ListSkeleton /> : null}
        <div className="grid gap-4">
          {triggers.map((trigger) => {
            const meta = SPEC_META[trigger.spec.type];
            const Icon = meta.icon;
            const nextRun = trigger.nextRunAt ? formatDateTime(trigger.nextRunAt) : null;
            const lastRun = trigger.lastRunAt ? formatDateTime(trigger.lastRunAt) : null;
            return (
              <div key={trigger.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" />
                      <h3 className="font-semibold">{trigger.name}</h3>
                      <Badge variant="secondary">{meta.label}</Badge>
                      {trigger.enabled ? <Badge>Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {trigger.target.kind === 'agent' ? 'Agent' : 'Workflow'} · {targetName(trigger.target)}
                      {trigger.spec.type === 'schedule' ? (
                        <>
                          {' · '}
                          <span className="font-mono">{trigger.spec.cron}</span>
                          {trigger.spec.timezone ? ` (${trigger.spec.timezone})` : ''}
                        </>
                      ) : null}
                      {trigger.spec.type === 'email' ? ` · ${trigger.spec.mailbox}` : null}
                    </p>
                    {nextRun || lastRun ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {nextRun ? `Next run: ${nextRun}` : null}
                        {nextRun && lastRun ? ' · ' : null}
                        {lastRun ? `Last run: ${lastRun}` : null}
                      </p>
                    ) : null}
                    {trigger.lastError ? (
                      <p className="mt-1 text-xs text-destructive">Last error: {trigger.lastError}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void toggleEnabled(trigger)}
                    >
                      {trigger.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => startEdit(trigger)}
                    >
                      Edit
                    </Button>
                    <ConfirmButton
                      size="icon-sm"
                      variant="destructiveGhost"
                      disabled={busy}
                      onConfirm={() => deleteTrigger(trigger.id)}
                      title="Delete trigger"
                      description={`Delete ${trigger.name} and stop future runs?`}
                    >
                      <Trash2 className="size-4" />
                    </ConfirmButton>
                  </div>
                </div>
              </div>
            );
          })}
          {triggers.length === 0 && !triggersQuery.isPending ? (
            <EmptyState
              title="No triggers yet"
              description="Create a trigger above to run an agent or workflow on a schedule, webhook, or incoming email."
            />
          ) : null}
        </div>
      </FormSection>
    </div>
  );
}

/** Rebuild a CreateTriggerInput from an existing trigger (for in-place toggles). */
const triggerInput = (trigger: Trigger): CreateTriggerInput => ({
  name: trigger.name,
  enabled: trigger.enabled,
  target: trigger.target,
  taskTemplate: trigger.taskTemplate,
  spec: trigger.spec,
});
