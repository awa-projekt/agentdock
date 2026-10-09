import type { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { END, START, StateGraph } from '@langchain/langgraph';
import { createAgent, ToolStrategy, tool } from 'langchain';
import { z } from 'zod';

/**
 * What the host injects as LangGraph runtime `context`. Declared here, not
 * imported: the artifact has no dependency on agentdock. The `writer` name
 * matches `agents.writer` in agentdock.workflow.json.
 */
type WriterAgent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[] }>;

const ContextSchema = z.object({
  agents: z.object({ writer: z.custom<WriterAgent>() }),
});

const Triage = z.object({
  category: z.enum(['billing', 'bug', 'question']),
  priority: z.enum(['low', 'high']),
  summary: z.string(),
});

const InputSchema = z.object({
  email: z.string().describe("The customer's email address"),
  text: z.string().describe('The ticket text'),
});

const outputFields = {
  reply: z.string(),
  triage: Triage,
};

const OutputSchema = z.object(outputFields);

const StateSchema = InputSchema.extend(outputFields);

const lookupCustomer = tool(
  async ({ email }) => {
    const plan = email.endsWith('@acme.com') ? 'enterprise' : 'free';
    return { email, plan };
  },
  {
    name: 'lookup_customer',
    description: 'Look up the plan a customer is on by their email address.',
    schema: z.object({ email: z.string() }),
  },
);

const triager = createAgent({
  name: 'triager',
  model: 'openai:gpt-5.6-luna',
  tools: [lookupCustomer],
  systemPrompt:
    'You triage support tickets. Look up the customer first. Enterprise customers reporting a bug are high priority; everything else is low.',
  responseFormat: ToolStrategy.fromSchema(Triage),
});

const messageText = (message: BaseMessage | undefined): string => message?.text ?? '';

const graph = new StateGraph({ input: InputSchema, output: OutputSchema, state: StateSchema, context: ContextSchema })
  .addNode('classify', async (state) => {
    const result = await triager.invoke({
      messages: [{ role: 'user', content: `From: ${state.email}\n\n${state.text}` }],
    });
    return { triage: result.structuredResponse };
  })
  .addNode('draftReply', async (state, config) => {
    const writer = config.context?.agents.writer;
    if (!writer) throw new Error("No 'writer' agent in context. Pass one when invoking locally.");
    const result = await writer.invoke({
      messages: [
        {
          role: 'user',
          content: `Write a short, friendly support reply to this ${state.triage.category} ticket.\n\n${state.text}`,
        },
      ],
    });
    return { reply: messageText(result.messages.at(-1)) };
  })
  .addNode('escalate', (state) => ({
    reply: `Escalated to on-call: [${state.triage.category}] ${state.triage.summary}`,
  }))
  .addEdge(START, 'classify')
  .addConditionalEdges('classify', (state) => (state.triage.priority === 'high' ? 'escalate' : 'draftReply'), [
    'escalate',
    'draftReply',
  ])
  .addEdge('draftReply', END)
  .addEdge('escalate', END)
  .compile();

export default graph;
