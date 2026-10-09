import type { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

/**
 * What the host injects as LangGraph runtime `context`. Declared here, not
 * imported: the artifact has no dependency on agentdock. The names match
 * `agents` and `tools` in agentdock.workflow.json.
 */
type Agent = Runnable<{ messages: BaseMessageLike[] }, { messages: BaseMessage[]; structuredResponse?: unknown }>;

const ContextSchema = z.object({
  agents: z.object({ 'content-writer': z.custom<Agent>() }),
  tools: z.object({ publish_post: z.custom<StructuredToolInterface>() }),
});

const CHANNELS = ['blog', 'twitter', 'linkedin', 'newsletter'] as const;

const Article = z.object({
  title: z.string(),
  body: z.string().describe('Markdown body without a leading H1'),
  channel: z.enum(CHANNELS),
});
type Article = z.infer<typeof Article>;

/** What the reviewer sends back; `approved` alone rejects, edits ride along with an approval. */
const Review = z.object({
  approved: z.boolean(),
  title: z.string().optional(),
  body: z.string().optional(),
  channel: z.enum(CHANNELS).optional(),
  feedback: z.string().optional(),
});

const InputSchema = z.object({
  brief: z.string().describe('What the post should cover, who it is for, and any constraints'),
});

const Status = z.enum(['published', 'rejected']);

const OutputSchema = z.object({
  status: Status,
  url: z.string().optional(),
  article: Article,
});

const StateSchema = InputSchema.extend({
  article: Article.optional(),
  feedback: z.string().optional(),
  rounds: z.number().optional(),
  decision: z.enum(['approve', 'revise', 'reject']).optional(),
  status: Status.optional(),
  url: z.string().optional(),
});

const MAX_ROUNDS = 3;

const lastText = (messages: ReadonlyArray<BaseMessage>): string => messages.at(-1)?.text ?? '';

/** MCP tools answer with content blocks; the mock platform puts its JSON receipt in the first text block. */
const McpTextResult = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) });
const Receipt = z.object({ url: z.string() });

const graph = new StateGraph({ input: InputSchema, output: OutputSchema, state: StateSchema, context: ContextSchema })
  .addNode('draft', async (state, config) => {
    const writer = config.context?.agents['content-writer'];
    if (!writer) throw new Error("No 'content-writer' agent in context. Pass one when invoking locally.");
    const brief = {
      brief: state.brief,
      instruction: state.feedback
        ? 'Revise the previous draft so it addresses the reviewer feedback. Return the whole article.'
        : 'Write a publish-ready post for this brief.',
    };
    const withDraft = state.article ? { ...brief, previousDraft: state.article } : brief;
    const request = state.feedback ? { ...withDraft, feedback: state.feedback } : withDraft;
    const result = await writer.invoke({ messages: [{ role: 'user', content: JSON.stringify(request) }] });
    const article = Article.parse(result.structuredResponse ?? JSON.parse(lastText(result.messages)));
    return { article, rounds: (state.rounds ?? 0) + 1 };
  })
  .addNode('review', (state) => {
    if (!state.article) throw new Error('Nothing to review: the draft step produced no article.');
    const review = Review.parse(
      interrupt({
        title: 'Review & approve post',
        description: 'Edit the draft as needed, then approve it for publishing or send it back with feedback.',
        input: state.article,
        responseSchema: JSON.stringify(z.toJSONSchema(Review)),
      }),
    );
    const article: Article = {
      title: review.title ?? state.article.title,
      body: review.body ?? state.article.body,
      channel: review.channel ?? state.article.channel,
    };
    const decision = review.approved
      ? 'approve'
      : review.feedback && (state.rounds ?? 0) < MAX_ROUNDS
        ? 'revise'
        : 'reject';
    return { article, decision, feedback: review.feedback };
  })
  .addNode('publish', async (state, config) => {
    const publishPost = config.context?.tools.publish_post;
    if (!publishPost) throw new Error("No 'publish_post' tool in context. Pass one when invoking locally.");
    if (!state.article) throw new Error('Nothing to publish.');
    const receipt: unknown = await publishPost.invoke(state.article);
    const mcp = McpTextResult.safeParse(receipt);
    const parsed = Receipt.safeParse(mcp.success ? JSON.parse(mcp.data.content[0]?.text ?? '{}') : receipt);
    return { status: 'published', url: parsed.success ? parsed.data.url : undefined };
  })
  .addNode('reject', () => ({ status: 'rejected' }))
  .addEdge(START, 'draft')
  .addEdge('draft', 'review')
  .addConditionalEdges(
    'review',
    (state) => (state.decision === 'approve' ? 'publish' : state.decision === 'revise' ? 'draft' : 'reject'),
    ['publish', 'draft', 'reject'],
  )
  .addEdge('publish', END)
  .addEdge('reject', END)
  .compile();

export default graph;
