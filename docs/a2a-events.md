# A2A Events

This page documents the [A2A protocol](https://a2a-protocol.org) events AgentDock
emits, so you can build a client that talks to AgentDock agents and workflows and
knows exactly what to expect on the wire.

Both agents and workflows are exposed as A2A endpoints and stream the **same three
top-level event kinds**. A workflow additionally reports its run and step
progress, including the activity of agents and tools it calls, as wrapped
workflow events — see [Workflow events](#workflow-events) and
[Agents and tools inside workflows](#agents-and-tools-inside-workflows).

## Transport

Every agent and workflow is reachable as a standard A2A server:

| Resource | A2A base path | Agent card |
| --- | --- | --- |
| Agent | `/agents/:agentId/a2a` | `/agents/:agentId/a2a/.well-known/agent-card.json` |
| Workflow | `/workflows/:workflowId/a2a` | `/workflows/:workflowId/a2a/.well-known/agent-card.json` |

Clients interact through the normal A2A JSON-RPC methods (`message/send`,
`message/stream`, `tasks/get`, `tasks/cancel`, …). To observe execution live, call
`message/stream` and consume the server-sent event stream. Everything below
describes the objects that arrive on that stream.

Use any A2A-compliant client; AgentDock builds on
[`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk), so the
`Task`, `Message`, `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` types are
the same ones that SDK exposes.

## What a request can carry

A user message's parts all reach an agent's model: `text` parts as text, `file`
parts as images, audio, video or documents (inline `bytes` or an http(s) `uri`),
and `data` parts as JSON. Data parts that steer the run (an
`input-required-response`, a workflow envelope) are read by AgentDock and not
shown to the model. Files are rendered for the model's provider: what a provider
cannot take (audio for Anthropic, say) arrives as a note naming the file, not
silently dropped, and text files are decoded to text.

### Pointing a run's integrations elsewhere

The message that starts a task may name, in its `metadata`, MCP integrations the
run should reach at another server, e.g. an eval case's own copy of a service:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": {
    "kind": "message", "messageId": "m-1", "role": "user",
    "parts": [{ "kind": "data", "data": { "product_id": "42" } }],
    "metadata": {
      "agentdock/integrations": {
        "catalog": { "endpoint": "http://127.0.0.1:41001/mcp", "bearerToken": "optional" }
      }
    }
  } }
}
```

- Every tool call of the run to that integration goes to `endpoint`: the agent's
  own tools, its `send_task` subagents, and in a workflow every bound agent and
  bound tool. Policy and audit apply as for any call.
- The connection's stored credential is never sent there; `bearerToken`, when
  given, is sent as `Authorization: Bearer …`.
- Only an admin may set it (a session or bearer token of an admin; any caller
  when auth is disabled), only for registered MCP integrations, and only to an
  http(s) URL. Anything else is refused with a 403 JSON-RPC error.
- The task keeps the overrides of the message that started it, across resumes
  and recovery; a later message cannot change them. They are stored with the
  task's history, `bearerToken` included, and come back with it from
  `tasks/get`, so give a run a token scoped to that run.
- A tool that needs approval is denied in such a run: an approved call would
  execute later against the registered endpoint.

### An unreachable integration fails the run

A tool call whose MCP server cannot be reached is tried again (three retries,
backing off from half a second). A call that certainly never reached the server
is retried for every tool, one that may have arrived (connection reset, a 502/503/504
from a proxy) only for read-only tools. A server still unreachable then fails the
run (`failed`, naming the integration and endpoint) instead of answering the model
with an error it would read as "no data". An error the server itself returns is
answered to the model as before.

## The execution model

A request to an agent or workflow always produces a **Task**. The stream then
carries that task through its lifecycle. Only three event kinds ever appear at the
top level of the stream:

| `kind` | Type | When |
| --- | --- | --- |
| `task` | `Task` | First event of a brand-new task. |
| `status-update` | `TaskStatusUpdateEvent` | Lifecycle transitions **and** every incremental update (reasoning, tool calls, workflow progress…). |
| `artifact-update` | `TaskArtifactUpdateEvent` | The response: streamed text chunks, or the whole response at once. |

> **Key point for client authors:** AgentDock never emits a bare top-level
> `message` event. Rich, structured updates (reasoning, tool calls, workflow step
> progress, …) are delivered as a `Message` **nested inside** a `status-update`
> whose `state` is `working`. See [Data messages](#data-messages).

Every event carries `taskId` (`id` on the `task` event) and `contextId` so you can
correlate it with the task it belongs to.

### Task states

The `status.state` field follows the A2A `TaskState` enum. AgentDock emits:

| State | `final` | Meaning |
| --- | --- | --- |
| `submitted` | — | Task accepted. Carried by the initial `task` event. |
| `working` | `false` | Execution in progress. Also the state used to carry all data-message updates. |
| `input-required` | `false` | Execution paused; the client must send another message to continue (a tool call needs approval, or a workflow called `interrupt()`). The stream closes after it. |
| `completed` | `true` | Finished successfully. `status.message` holds the final answer. |
| `failed` | `true` | Errored. `status.message` holds the error text. |
| `canceled` | `true` | Canceled via `tasks/cancel`. |
| `rejected` | `true` | Request refused before execution (e.g. input did not match a workflow's input contract). |

A `final: true` status-update, or an `input-required` one, is always the last
event of a stream. After it, the stream closes.

## Top-level events

### `task` — new task

Emitted once, only when the request creates a new task (not when continuing an
existing one).

```jsonc
{
  "kind": "task",
  "id": "<taskId>",
  "contextId": "<contextId>",
  "status": { "state": "submitted", "timestamp": "2026-06-25T12:00:00.000Z" },
  "history": [ /* the user Message that started the task */ ]
}
```

### `status-update` — lifecycle and updates

The workhorse event. The shape is always:

```jsonc
{
  "kind": "status-update",
  "taskId": "<taskId>",
  "contextId": "<contextId>",
  "final": false,
  "status": {
    "state": "working",
    "timestamp": "2026-06-25T12:00:01.000Z",
    "message": { /* optional Message — see below */ }
  }
}
```

There are two flavours:

- **Lifecycle transitions** — `working` (start), `completed`, `failed`,
  `canceled`, `rejected`, `input-required`. `failed` and `rejected` carry a text
  `message`; `completed` carries the final answer as a text part, or as a `data`
  part when the agent has an output contract; `input-required` carries a `data`
  part describing the request; `canceled` carries no message. All terminal
  states set `final: true`.
- **Data carriers** — `state: "working"`, `final: false`, with a `message`
  containing one or more `data` parts. These are the incremental updates
  ([Data messages](#data-messages)).

Completed example:

```jsonc
{
  "kind": "status-update",
  "taskId": "<taskId>",
  "contextId": "<contextId>",
  "final": true,
  "status": {
    "state": "completed",
    "timestamp": "2026-06-25T12:00:05.000Z",
    "message": {
      "kind": "message",
      "role": "agent",
      "messageId": "<uuid>",
      "taskId": "<taskId>",
      "contextId": "<contextId>",
      "parts": [{ "kind": "text", "text": "The full final answer." }]
    }
  }
}
```

### `artifact-update` — response

As an agent produces its answer, text is streamed as artifact deltas. The full
response can be reconstructed by concatenating the text parts in order.

```jsonc
{
  "kind": "artifact-update",
  "taskId": "<taskId>",
  "contextId": "<contextId>",
  "append": true,      // false on the first chunk, true thereafter
  "lastChunk": false,
  "artifact": {
    "artifactId": "<taskId>-response",
    "name": "<agent or workflow name>",
    "parts": [{ "kind": "text", "text": "partial text…" }]
  }
}
```

- `append: false` marks the **first** chunk (start a fresh buffer); `append: true`
  means concatenate onto what you have.
- The `artifactId` is stable (`<taskId>-response`) so all chunks target the same
  artifact.
- Agent text chunks never set `lastChunk`; the end of the response is the
  `completed` status-update.
- An agent with an output contract streams no text. It emits one artifact with
  a single `data` part holding the structured answer (`append: false`,
  `lastChunk: true`).
- A workflow emits one artifact with its whole output as text (`append: false`,
  `lastChunk: true`) just before `completed`.
- The final answer is **also** delivered in the `completed` status-update's
  `status.message`, so a client that only cares about the final answer can ignore
  artifact events entirely.

## Data messages

Incremental, structured progress is delivered as a `Message` nested in a
`working` status-update. The message's `parts` contain `data` parts, each with a
`type` discriminator:

```jsonc
{
  "kind": "status-update",
  "taskId": "<taskId>",
  "contextId": "<contextId>",
  "final": false,
  "status": {
    "state": "working",
    "timestamp": "…",
    "message": {
      "kind": "message",
      "role": "agent",
      "messageId": "<uuid>",
      "taskId": "<taskId>",
      "contextId": "<contextId>",
      "parts": [{ "kind": "data", "data": { "type": "tool-call", "…": "…" } }]
    }
  }
}
```

### Agent data-message types

These are emitted by the agent executor while a model is running:

| `data.type` | Fields | Meaning |
| --- | --- | --- |
| `reasoning` | `text` | A chunk of the model's reasoning/thinking output. |
| `tool-call` | `toolName`, `toolCallId`, `input` | The model invoked a tool. `input` is the (JSON-safe) tool arguments. |
| `tool-result` | `toolName`, `toolCallId`, `output` | A tool returned. `output` is the (JSON-safe) result. |
| `tool-error` | `toolName`, `toolCallId`, `error` | A tool threw. `error` is the message string. |
| `finish` | `finishReason`, `usage` | The model run finished. `usage` is token usage. |
| `send-task-progress` | `toolName`, `agentId`, `agentName`, `taskId`, `state`, `text?`, `event?` | Progress of a subagent reached through `send_task`. `state` is `submitted`, `working`, or the subagent's final state; `working` updates carry the subagent's own data message in `event` (the types above, plus `model-call` with its usage). Deeper delegations arrive nested inside `event`. |

> Response text is **not** a data message — it is streamed as an
> [`artifact-update`](#artifact-update-response). Reasoning, in contrast, is a
> data message (`type: reasoning`).

## Workflow events

When the resource is a **workflow**, the same three top-level event kinds apply,
plus every workflow run and step event is mirrored onto the stream as a data
message with `type: "workflow-event"`:

```jsonc
{
  "kind": "data",
  "data": {
    "type": "workflow-event",
    "event": {
      "type": "step-started",
      "id": "<eventId>",
      "runId": "<runId>",
      "workflowId": "<workflowId>",
      "taskId": "<taskId>",
      "timestamp": "…",
      "stepId": "summarize",
      "label": "summarize",
      "input": "…"
    }
  }
}
```

The nested `event` object is a `WorkflowRunEvent`. It is also persisted durably and
can be fetched after the fact via `GET /workflows/runs/:runId/events`. The durable
write always happens before the stream event, so a row exists by the time you see
the event live.

A new workflow task streams `task` (submitted), `working`, then `run-started`,
the step events, and finally an `artifact-update` with the output followed by
`completed`. If the task input does not match the workflow's input contract,
the task is `rejected` before a run is created.

### Run-level events

All run events share `id`, `runId`, `workflowId`, `taskId`, `timestamp`.

| `event.type` | Extra fields | Meaning |
| --- | --- | --- |
| `run-started` | `input` | The workflow run began. Not emitted when a run resumes. |
| `run-completed` | `output` | The run finished successfully with this final output. |
| `run-failed` | `error` | The run failed. Followed by a top-level `failed` status-update. |
| `run-canceled` | — | The run was canceled. Followed by a `canceled` status-update. |

### Step-level events

A step is a LangGraph node or `task()` the workflow code ran, as the graph view
draws it. Steps are discovered as the graph streams, not declared up front.
Step events additionally carry `stepId`, `label` (display label, currently the
same as `stepId`) and `executionId`. There is no step type.

- `stepId` is the step's path in the graph: the node or task name, and
  `<parent>:<node>` for a node of a compiled subgraph that was added as a node
  (`team:research`). The subgraph node itself (`team`) is a step too.
- `executionId` is LangGraph's task id for one run of the step. A loop that
  comes back to a node, or a `Send` fan-out to it, gives the same `stepId`
  several executions; group events by `executionId` to tell them apart. Events
  recorded before executions had ids carry none.

| `event.type` | Extra fields | Meaning |
| --- | --- | --- |
| `step-started` | `input` | A step began, with its input rendered as JSON. |
| `step-progress` | `state`, `data` | Activity inside a step. `state` identifies the kind of progress (see below). |
| `step-completed` | `output` | A step finished, with its output rendered as JSON. |
| `step-failed` | `error` | The graph threw. `stepId` is the latest step that started (`workflow` if none had). Followed by `run-failed`. |
| `human-input-requested` | `actionId`, `title`, `description?`, `input?`, `responseSchema?`, `interrupts?` | The graph called `interrupt()` and the run paused. |
| `human-input-resolved` | `actionId`, `response` | The pending request was answered (`response` is JSON text) and the run resumed. Emitted in place of `run-started` on a resumed task. |

### `step-progress` states

| `data.state` | Source | Payload fields |
| --- | --- | --- |
| `progress` | A node inside the step that the graph view does not draw (a bound agent's own graph, a child workflow's nodes, a subgraph called from inside a node body) | `phase` (`started` / `completed`), `node`, `namespace`. |
| `progress` | `getWriter()` chunks the workflow code writes (`custom` stream mode) | The written object, or `{ value }` for a non-object. |
| `tool-call` | Bound integration tool (`context.tools.<name>`) | `tool` (catalog tool id), `name` (binding name), `input`. |
| `tool-result` | Bound integration tool | `tool`, `name`, `output`. |
| `tool-error` | Bound integration tool | `tool`, `name`, `error`. |
| `agent-tool-call` | Bound internal agent, one of its own tool calls | `agentId`, `type: "tool-call"`, `toolName`, `toolCallId`, `input`. |
| `agent-tool-result` | Bound internal agent | `agentId`, `type: "tool-result"`, `toolName`, `toolCallId`, `output`. |
| `agent-tool-error` | Bound internal agent | `agentId`, `type: "tool-error"`, `toolName`, `toolCallId`, `error`. |
| `agent-delegation` | A `send_task` subagent of a bound internal agent | `agentId`, `event` (the relayed `send-task-progress` part, nested again per delegation level). |
| `model-call` | A model call of a bound agent or a bound model (`context.models.<name>`) ended | `agentId` or `modelName`, `model` (`provider:model`), `usage` (`null` when the provider reports none), `toolCalls`, `reasoningEstimated`. |
| `model-token` | A bound model streams text | `modelName`, `text`. |
| `a2a-artifact` | Bound agent | `agentId` plus `text` (a text chunk), or `toolCall` and `args` (a chunk of a tool call's arguments, which is how a structured answer streams), or `data` (a data artifact from an external agent). |
| `a2a-send` | Bound external agent | `agentId`, `agentName`, `message?`, `data?` — what was sent. |
| `a2a-task` | Bound external agent | `agentId`, `taskId`, `taskState` — the remote task was created. |
| `a2a-status` | Bound external agent | `agentId`, `taskState`, `final`, `message?`, `data?` — a status-update from the remote agent. |
| `a2a-message` | Bound external agent | `agentId`, `message?`, `data?` — a message from the remote agent. |

## Input-required and resuming

When a task enters `input-required`, the stream emits an `input-required`
status-update whose `status.message` contains one `data` part describing what is
needed, then the stream closes. To continue, send a new `message/send` (or
`message/stream`) on the **same** `taskId`/`contextId` carrying the response.

### Agents

An agent pauses when a tool call needs approval: the integrations gateway froze
the call, or the tool returned `{ status: "input-required", request }`. The
`data` part is the request, for a gateway approval:

```jsonc
{
  "type": "workflow-tool-approval-request",
  "actionId": "<approvalId>",
  "title": "Approve <toolId>",
  "description": "The agent wants to call <toolId>. Approve or decline the call.",
  "tool": { "path": "<toolId>", "args": { /* call arguments */ } },
  "resume": { /* internal continuation; ignore */ }
}
```

Resume with a `data` part `{ "type": "input-required-response", "response": { "action": "accept" } }`
(`decline` and `cancel` refuse; `content` may carry a value), or with a plain
text message: `yes`/`approve`/`accept`, `no`/`decline`/`deny`, `cancel`, or
JSON.

### Workflows

A workflow pauses when its graph calls `interrupt()`, including when a bound
tool call is frozen for approval. The `data` part is:

```jsonc
{
  "type": "workflow-human-input-request",
  "actionId": "<actionId>",
  "runId": "<runId>",
  "stepId": "<stepId>",
  "title": "…",
  "description": "…",        // optional
  "input": { },               // optional
  "responseSchema": "…",      // optional
  "interrupts": [ { "id": "…", "value": { } } ]  // the raw LangGraph interrupts
}
```

`title`, `description`, `input` and `responseSchema` are read from the interrupt
value (`title` falls back to `gate`, then `Input required`). For a tool
approval, `actionId` is the gateway approval id and the interrupt value is a
`workflow-tool-approval-request` like the one above.

To resume, send a `data` part with `type: "workflow-human-input-response"`, the
matching `actionId`, and a `response` object; it becomes the value `interrupt()`
returns. For a tool approval, `response.action` of `decline` or `cancel` denies
the call and anything else approves it.

```jsonc
{
  "kind": "message",
  "role": "user",
  "messageId": "<uuid>",
  "taskId": "<taskId>",
  "contextId": "<contextId>",
  "parts": [{
    "kind": "data",
    "data": {
      "type": "workflow-human-input-response",
      "actionId": "…",
      "response": { "approved": true }
    }
  }]
}
```

A generic `{ "type": "input-required-response", "response": … }` part is also
accepted and answers the latest pending request (a non-object response is
wrapped as `{ value }`). If no run is waiting on that task, or the action is not
the pending one, the workflow replies with a `rejected` status-update.

## Agents and tools inside workflows

Workflow code calls agents through `context.agents.<name>`, tools through
`context.tools.<name>` and models through `context.models.<name>` (see
[Workflows](workflows.md)). Their activity is reported as `step-progress` on
the step whose task made the call, never as raw agent events on the workflow's
stream.

- **Internal agents** run in-process as a LangGraph subgraph. Each call is
  recorded as its own agent run (`GET /workflows/runs/:runId/agent-runs`). Its
  model output streams as `a2a-artifact` progress, its own tool calls as
  `agent-tool-call` / `agent-tool-result` / `agent-tool-error`, what its
  `send_task` subagents report as `agent-delegation`, and every model call as
  `model-call` with its usage.
- **External A2A agents** are called over A2A. The workflow tags its message
  with a `workflow-agent-invocation` data part (`workflowId`, `runId`, `taskId`,
  `contextId`, `stepId`) so the remote run can be correlated with the step, and
  maps the remote stream onto `a2a-send`, `a2a-task`, `a2a-status`,
  `a2a-artifact` and `a2a-message` progress. A remote agent that fails or asks
  for input fails the step; model approval gates with `interrupt()` instead.
- **Tools** report `tool-call`, then `tool-result` or `tool-error`.
- **Models** stream their text as `model-token` and report each call as
  `model-call`.

An eval whose target is a workflow reads the run's cost and tool calls from
these events.

## Source reference

| Concern | File |
| --- | --- |
| Event factories (all top-level event shapes) | `packages/sdk/src/a2a/events.ts` |
| Agent executor (emits agent events) | `packages/sdk/src/a2a/executor.ts` |
| `send_task` progress relay | `packages/api/src/agents/runtime-layers.ts` |
| Workflow executor (run lifecycle, terminal status, resume) | `packages/sdk/src/workflows/executor.ts` |
| Graph streaming, step events and interrupts | `packages/sdk/src/workflows/runtime.ts` |
| Workflow event factories | `packages/sdk/src/workflows/events.ts` |
| Agent, tool and model bindings (progress inside a step) | `packages/sdk/src/workflows/bindings.ts`, `packages/sdk/src/workflows/agent-invoker.ts`, `packages/sdk/src/workflows/activity.ts` |
| Step paths and executions | `packages/sdk/src/workflows/step-paths.ts` |
| Run-scoped integration overrides | `packages/api/src/a2a/integration-overrides.ts`, `packages/api/src/gateway/run-scoped-integrations.ts` |
| Tool approval requests | `packages/api/src/gateway/tools.ts`, `packages/api/src/workflows/tool-invoker.ts` |
| `WorkflowRunEvent` and envelope schemas | `packages/sdk/src/schemas/workflows.ts` |
