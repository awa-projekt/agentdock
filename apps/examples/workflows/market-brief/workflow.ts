import type { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { entrypoint, getConfig, getWriter, interrupt, task } from '@langchain/langgraph';
import { z } from 'zod';

/**
 * What the host injects as LangGraph runtime `context`. Declared here, not
 * imported. Bound agents are runnables over messages; an agent that declares
 * an output schema also returns `structuredResponse`.
 */
type Agent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse?: unknown }>;

type Ctx = {
  agents: { research: Agent; writer: Agent };
};

type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json };

const agents = (): Ctx['agents'] => {
  const context = getConfig().context;
  if (!context) throw new Error('No runtime context. Pass `context: { agents }` when invoking locally.');
  return context.agents;
};

const Finding = z.object({
  competitor: z.string(),
  headline: z.string(),
  impact: z.enum(['low', 'medium', 'high']),
});
type Finding = z.infer<typeof Finding>;

type BriefInput = { readonly week: number; readonly competitors: ReadonlyArray<string> };

type OutlineReview = { readonly decision: 'approve' | 'edit'; readonly outline?: ReadonlyArray<string> };

const DEFAULT_OUTLINE = ['Executive Summary', 'Competitor Moves', 'Recommended Actions'];

const lastText = (messages: ReadonlyArray<BaseMessage>): string => messages.at(-1)?.text ?? '';

/** Normalizes an agent's answer to text: a structured response is serialized, a text turn is taken as-is. */
const ask = async (agent: Agent, payload: Json): Promise<string> => {
  const result = await agent.invoke({ messages: [{ role: 'user', content: JSON.stringify(payload) }] });
  return result.structuredResponse === undefined
    ? lastText(result.messages)
    : JSON.stringify(result.structuredResponse);
};

const researchCompetitor = task(
  { name: 'researchCompetitor', retry: { maxAttempts: 3, initialInterval: 250 } },
  async (competitor: string, week: number): Promise<Finding> => {
    getWriter()?.({ competitor });
    const answer = await ask(agents().research, {
      competitor,
      week,
      instruction: "Summarize this competitor's most important public move in the given calendar week.",
    });
    return Finding.parse(JSON.parse(answer));
  },
);

const writeBrief = task(
  'writeBrief',
  async (input: {
    readonly week: number;
    readonly outline: ReadonlyArray<string>;
    readonly findings: ReadonlyArray<Finding>;
  }): Promise<string> => {
    const answer = await ask(agents().writer, {
      week: input.week,
      outline: [...input.outline],
      findings: input.findings,
      instruction: 'Write the weekly market brief following the outline.',
    });
    return answer;
  },
);

const graph = entrypoint('weeklyBrief', async (input: BriefInput) => {
  const findings = await Promise.all(input.competitors.map((competitor) => researchCompetitor(competitor, input.week)));

  const review = interrupt<
    {
      readonly title: string;
      readonly input: { readonly outline: ReadonlyArray<string>; readonly findings: ReadonlyArray<Finding> };
    },
    OutlineReview
  >({
    title: 'Approve the brief outline',
    input: { outline: DEFAULT_OUTLINE, findings },
  });

  const outline = review.decision === 'edit' && review.outline ? review.outline : DEFAULT_OUTLINE;
  return writeBrief({ week: input.week, outline, findings });
});

export default graph;
