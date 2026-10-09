import type { Skill } from 'agentdock-sdk/schemas';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field, FormSection } from '@/components/form';
import { ListSkeleton } from '@/components/Loading';
import { SectionHeader } from '@/components/SectionHeader';
import { type FeedbackMessage, StatusMessage } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseList, toErrorMessage } from '@/lib/format';
import { useAddSkill, usePullSkills, useRemoveSkill, useSkills } from '@/lib/queries';

export function SkillsView() {
  const skillsQuery = useSkills();
  const skills = skillsQuery.data ?? [];
  const addSkill = useAddSkill();
  const pullSkills = usePullSkills();
  const removeSkill = useRemoveSkill();
  const pending = addSkill.isPending || pullSkills.isPending || removeSkill.isPending;
  const [content, setContent] = useState(
    '---\nname: my-skill\ndescription: What this skill does and when to use it.\n---\n\n# My Skill\n\nInstructions for the agent.',
  );
  const [source, setSource] = useState('vercel-labs/agent-skills');
  const [skillFilter, setSkillFilter] = useState('');
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillContent, setSelectedSkillContent] = useState('');
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;
  const selectedSkillEditable = selectedSkill?.source === 'manual';

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) {
      setSelectedSkillId(null);
      setSelectedSkillContent('');
    }
  }, [selectedSkill, selectedSkillId]);

  const report = (success: string, failure: string) => ({
    onSuccess: () => setMessage({ kind: 'success' as const, text: success }),
    onError: (error: Error) => setMessage({ kind: 'error' as const, text: toErrorMessage(error, failure) }),
  });

  const saveManual = () => {
    setMessage(null);
    addSkill.mutate({ content, source: 'manual' }, report('Skill saved.', 'Failed to save skill.'));
  };

  const pull = () => {
    setMessage(null);
    const names = skillFilter.trim().length > 0 ? parseList(skillFilter) : [];
    pullSkills.mutate(
      { source, skills: [...names] },
      {
        onSuccess: (result) =>
          setMessage({
            kind: 'success',
            text: `Imported ${result.skills.length} skill${result.skills.length === 1 ? '' : 's'}.`,
          }),
        onError: (error) => setMessage({ kind: 'error', text: toErrorMessage(error, 'Failed to pull skills.') }),
      },
    );
  };

  const deleteSkill = (skillId: string) => {
    setMessage(null);
    removeSkill.mutate(skillId, report('Skill deleted.', 'Failed to delete skill.'));
  };

  const selectSkill = (skill: Skill) => {
    setSelectedSkillId(skill.id);
    setSelectedSkillContent(skill.content);
  };

  const saveSelectedSkill = () => {
    if (!selectedSkill || !selectedSkillEditable) return;
    setMessage(null);
    addSkill.mutate(
      { content: selectedSkillContent, source: 'manual' },
      report('Skill updated.', 'Failed to update skill.'),
    );
  };

  return (
    <div className="space-y-8">
      <SectionHeader title="Skills" description="Install and manage global Agent Skills." />
      {message ? <StatusMessage kind={message.kind}>{message.text}</StatusMessage> : null}
      {skillsQuery.isError ? (
        <StatusMessage kind="error">{toErrorMessage(skillsQuery.error, 'Could not load skills.')}</StatusMessage>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <FormSection
          title="Pull Skills"
          description="Runs the Vercel skills CLI globally for Agentdock, then imports SKILL.md files."
        >
          <Field
            label="Source"
            htmlFor="skill-source"
            description="GitHub shorthand, git URL, or local path supported by npx skills add."
          >
            <Input id="skill-source" value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <Field
            label="Skill names"
            htmlFor="skill-filter"
            description="Comma-separated. Leave empty to import all skills from the source."
          >
            <Input
              id="skill-filter"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              placeholder="frontend-design, skill-creator"
            />
          </Field>
          <Button type="button" onClick={pull} disabled={pending || source.trim().length === 0}>
            Pull Skills
          </Button>
        </FormSection>

        <FormSection title="Add Skill" description="Paste a standards-compliant SKILL.md with YAML frontmatter.">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-56 font-mono text-sm"
          />
          <Button type="button" onClick={saveManual} disabled={pending}>
            Save Skill
          </Button>
        </FormSection>
      </div>

      <FormSection title="Installed Skills" description="Assign skills from each agent's create/edit view.">
        {skillsQuery.isPending ? <ListSkeleton /> : null}
        <div className="grid gap-4">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => selectSkill(skill)}>
                  <h3 className="font-semibold">{skill.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
                </button>
                <div className="flex items-center gap-2">
                  {skill.source ? <Badge variant="secondary">{skill.source}</Badge> : null}
                  <Button type="button" variant="outline" onClick={() => selectSkill(skill)} disabled={pending}>
                    {skill.source === 'manual' ? 'Edit' : 'View'}
                  </Button>
                  {skill.builtin ? null : (
                    <ConfirmButton
                      size="icon-sm"
                      variant="destructiveGhost"
                      disabled={pending}
                      onConfirm={() => deleteSkill(skill.id)}
                      title="Delete skill"
                      description={`Delete ${skill.name} from this Agentdock instance?`}
                    >
                      <Trash2 className="size-4" />
                    </ConfirmButton>
                  )}
                </div>
              </div>
            </div>
          ))}
          {skills.length === 0 && !skillsQuery.isPending ? (
            <EmptyState
              title="No skills installed"
              description="Pull a skill source or paste a SKILL.md to get started."
            />
          ) : null}
        </div>
      </FormSection>

      {selectedSkill ? (
        <FormSection
          title={selectedSkillEditable ? 'Edit Skill' : 'View Skill'}
          description={
            selectedSkillEditable
              ? 'Manual skills can be edited in place.'
              : selectedSkill.builtin
                ? 'Built-in skills ship with Agentdock and cannot be changed.'
                : 'Pulled skills are read-only here. Delete and pull again to update them.'
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold">{selectedSkill.name}</div>
                <div className="text-xs text-muted-foreground">{selectedSkill.source ?? 'manual'}</div>
              </div>
              <Button type="button" variant="ghost" onClick={() => setSelectedSkillId(null)}>
                Close
              </Button>
            </div>
            <Textarea
              value={selectedSkillEditable ? selectedSkillContent : selectedSkill.content}
              readOnly={!selectedSkillEditable}
              onChange={(event) => setSelectedSkillContent(event.target.value)}
              className="min-h-[480px] font-mono text-sm"
            />
            {selectedSkillEditable ? (
              <div className="flex justify-end">
                <Button type="button" onClick={saveSelectedSkill} disabled={pending}>
                  Save changes
                </Button>
              </div>
            ) : null}
          </div>
        </FormSection>
      ) : null}
    </div>
  );
}
