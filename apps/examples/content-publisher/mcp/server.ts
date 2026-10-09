/**
 * Mock "publishing platform" exposed as an MCP server.
 *
 * This stands in for whatever real system you'd publish to (a CMS, the Twitter
 * API, a newsletter provider, ...). It is intentionally tiny: it keeps an
 * in-memory list of "published" posts and hands back a fake public URL.
 *
 * Wire it into AgentDock as an MCP source pointing at:
 *     http://localhost:<MCP_PORT>/mcp
 * then give your publisher agent the `publish_post` tool.
 */
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

const MCP_PORT = Number(process.env.MCP_PORT ?? 8910);

/** Channels the mock platform accepts. Keep in sync with the UI's CHANNELS. */
const CHANNELS = ['blog', 'twitter', 'linkedin', 'newsletter'] as const;

type PublishedPost = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly channel: string;
  readonly url: string;
  readonly publishedAt: string;
};

const published: PublishedPost[] = [];

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'post';

const server = new FastMCP({
  name: 'mock-publishing-platform',
  version: '1.0.0',
  instructions:
    'A mock content publishing platform. Use list_channels to see where you can publish, then publish_post to publish approved content.',
});

server.addTool({
  name: 'list_channels',
  description: 'List the channels this platform can publish to.',
  parameters: z.object({}),
  execute: async () => JSON.stringify({ channels: CHANNELS }),
});

server.addTool({
  name: 'publish_post',
  description:
    'Publish a post to a channel. Only call this once the content has been approved by a human. Returns the public URL of the published post.',
  parameters: z.object({
    title: z.string().describe('The post title / headline.'),
    body: z.string().describe('The full post body (markdown allowed).'),
    channel: z.enum(CHANNELS).describe(`Where to publish. One of: ${CHANNELS.join(', ')}.`),
  }),
  execute: async ({ title, body, channel }) => {
    const id = `${Date.now().toString(36)}-${slugify(title)}`;
    const post: PublishedPost = {
      id,
      title,
      body,
      channel,
      url: `https://mock.example/${channel}/${id}`,
      publishedAt: new Date().toISOString(),
    };
    published.unshift(post);
    console.log(`[mock-publish] published "${title}" to ${channel} -> ${post.url}`);
    return JSON.stringify({
      status: 'published',
      id: post.id,
      url: post.url,
      channel: post.channel,
      publishedAt: post.publishedAt,
    });
  },
});

server.addTool({
  name: 'list_published',
  description: 'List posts that have been published so far (most recent first).',
  parameters: z.object({}),
  execute: async () =>
    JSON.stringify({
      posts: published.map(({ body: _body, ...rest }) => rest),
    }),
});

server.start({
  transportType: 'httpStream',
  httpStream: { port: MCP_PORT },
});

console.log(
  `[mock-publish] MCP server listening on http://localhost:${MCP_PORT}/mcp ` + `(channels: ${CHANNELS.join(', ')})`,
);
