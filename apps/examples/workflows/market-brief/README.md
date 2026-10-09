# Weekly market brief

A functional-API workflow artifact (`entrypoint` / `task` / `interrupt`).
One `researchCompetitor` task per competitor runs in parallel with a retry
policy, `interrupt()` pauses for outline sign-off, then `writeBrief` produces
the text. Both agents come from the runtime context the host injects:
`context.agents.research` and `context.agents.writer`.

The folder imports nothing from agentdock. Because functional-API graphs
declare no input schema, `agentdock.workflow.json` states the `input` JSON
Schema explicitly; the platform validates incoming tasks against it.

## Run locally

Bound agents are runnables over `{ messages }`. The workflow sends each one a
single user message whose content is a JSON payload and reads
`structuredResponse`, falling back to the last message's text. A `createAgent`
with a response format satisfies that:

```ts
import { Command, MemorySaver } from '@langchain/langgraph';
import { createAgent, ToolStrategy } from 'langchain';
import { z } from 'zod';
import graph from './workflow.ts';

const research = createAgent({
  model: 'openai:gpt-5.6-luna',
  systemPrompt: 'You research competitors. Answer the JSON request you receive.',
  responseFormat: ToolStrategy.fromSchema(
    z.object({ competitor: z.string(), headline: z.string(), impact: z.enum(['low', 'medium', 'high']) }),
  ),
});
const writer = createAgent({ model: 'openai:gpt-5.6-luna', systemPrompt: 'You write concise market briefs.' });

const config = {
  configurable: { thread_id: 'local', __pregel_checkpointer: new MemorySaver() },
  context: { agents: { research, writer } },
};
const paused = await graph.invoke({ week: 37, competitors: ['Acme', 'Globex'] }, config);
// paused.__interrupt__ carries the outline request; answer it:
const brief = await graph.invoke(new Command({ resume: { decision: 'approve' } }), config);
```

`interrupt()` needs a checkpointer to resume from. Locally you hand one in
through the `__pregel_checkpointer` configurable, exactly like the platform
does; the graph itself is compiled without one.

`agentdock run ./market-brief '{"week":37,"competitors":["Acme"]}'` does the
same, binding `research` and `writer` to `agents/<name>.agent.yaml` in your
project or to whatever `--agent name=<file|url>` names.

## Push to the platform

Inside an agentdock project, with this folder at `workflows/market-brief/`:

```sh
bun install --omit=peer
agentdock check workflows/market-brief
agentdock push market-brief   # binds `research` and `writer` by name
```
