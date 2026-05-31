# Next Steps

You already have the rough skeleton: agents/workflows exposed over A2A, graph workflow execution, MCP/OpenAPI/GraphQL/Google sources via executor, streamed A2A events, chat UI rendering, sessions/evals/traces. The main missing piece is not "can it run?" but "can it safely pause, ask humans, resume, audit, and survive real business-process edge cases?"

## Top Priority

1. Human-in-the-loop protocol for approvals and elicitation.
2. Durable workflow/task state and resumability.
3. First-class process event model for UI rendering.
4. Tool/API policy hardening before real side effects.
5. Workflow engine refactor from demo graph execution to business process orchestration.

## 1. Approvals And Elicitation

This is the biggest gap.

Current state:

- Executor is created with `onElicitation: 'accept-all'` in `packages/api/src/executor/service.ts`.
- Executor tools expose `execute` and `resume` in `packages/sdk/src/tools/executor/tools.ts`, so pause/resume exists at the tool layer.
- Agent streaming ignores AI SDK approval events: `tool-approval-request` and `tool-output-denied` are explicitly swallowed in `packages/sdk/src/a2a/executor.ts`.
- There is no dedicated A2A event/status shape for "waiting for user approval" or "needs form input".

What to build:

- Convert executor paused outcomes into A2A `input-required` task state or structured data messages.
- Add an approval/elicitation record in DB: `id`, `taskId`, `contextId`, `agentId`, `workflowId`, `toolName`, `risk`, `request`, `schema`, `status`, `decision`, `createdAt`, `resolvedAt`.
- Add API endpoints: list pending approvals, approve/deny/cancel, submit elicitation form.
- Wire UI cards with Approve/Deny/Form Submit buttons.
- Resume the paused executor/workflow from the human decision.
- Stop using `accept-all`; default should be "pause and ask" for side-effecting actions.

This should be priority 1 because any business process involving MCPs, POST APIs, email, tickets, finance, CRM, etc. needs an accountable approval boundary.

## 2. Durable Workflow Execution

Current workflow execution is mostly in-memory per request:

- `WorkflowTaskExecutor` uses `WorkflowEngine.layerMemory` in `packages/sdk/src/workflows/executor.ts`.
- Graph state is stored in local `Map`s in `executeGraph`.
- Cancellation is a local `Set` in memory.
- If the server restarts during a workflow, in-flight process state is lost.

What to harden:

- Persist workflow runs, node runs, node inputs/outputs, branch decisions, errors, retries, and approvals.
- Give each run a stable `processRunId`.
- Make node execution idempotent.
- Store every node transition as an append-only event.
- Resume from last completed node after crash/restart.
- Support long-running waits, timers, and external callbacks.

Business processes are rarely one request/response. They need days-long state, auditability, and safe recovery.

## 3. UI Event Model

Current UI renders tool events nicely, but it is still too generic:

- Agent emits data messages for `tool-call`, `tool-result`, `tool-error`.
- Workflow emits generic `workflow-node` data messages.
- UI has opinionated cards for tools/artifacts in `apps/web/src/event-renderers.tsx`.
- Workflow chat is available, but workflow persistence is currently not enabled for workflow targets in `apps/web/src/App.tsx`.

Missing:

- Dedicated event taxonomy: `process.started`, `node.started`, `node.completed`, `node.failed`, `approval.requested`, `approval.resolved`, `elicitation.requested`, `tool.executing`, `api.requested`, `api.completed`, `retry.scheduled`, etc.
- A process timeline view separate from chat.
- Workflow/node progress visualization during execution.
- Pending approvals surfaced globally, not buried inside chat.
- Workflow session persistence, not just agent chat persistence.
- Redaction rules before raw tool/API payloads hit the browser.

Prioritize a typed event schema shared between API, SDK, workflow executor, and web UI. The UI will get much cleaner once events are not inferred from ad-hoc `data.type` strings.

## 4. Tool And API Policy

Current source/tool management has useful pieces:

- Tools can be disabled/native/discoverable.
- Pinned tools are described to the agent.
- Communication policy exists between agents.

Still missing for real business use:

- Tool risk classification: read-only, write, destructive, external-send, financial, PII.
- Per-tool approval policy: always allow, always ask, ask above threshold, deny.
- Per-agent/per-workflow permission scopes.
- HTTP method policy for OpenAPI/direct APIs: GET maybe allowed, POST/PATCH/DELETE ask by default.
- Request preview before approval: method, URL, body diff, target system, affected entity.
- Secret redaction from traces, session history, tool events, and UI.
- SSRF/network egress restrictions for arbitrary MCP/OpenAPI endpoints.
- Rate limits, timeouts, retry policy, and budget caps per run.

If real MCPs and APIs are connected before this, agents can accidentally mutate external systems without a clear control plane.

## 5. Workflow Model

Current graph supports `input`, `template`, `condition`, `output`, and `agent` nodes. That is enough for demos but thin for business processes.

Needed node types:

- Human approval node.
- Human form/elicitation node.
- Tool/API call node.
- Wait/timer node.
- Webhook/callback wait node.
- Parallel/fan-out/fan-in node.
- Retry/compensation node.
- Subworkflow node.
- Assignment/escalation node.
- Data transform/validation node.

Needed execution semantics:

- Idempotency per node.
- Retries with backoff.
- Compensation/saga steps for side effects.
- Timeouts and SLAs.
- Versioned workflow definitions.
- Runs pinned to workflow version.
- Clear distinction between workflow definition, workflow run, node definition, node run.

## 6. A2A Forwarding

Approval/elicitation should flow through A2A so the web UI can display and respond to it.

Recommended shape:

- When an agent/tool needs input, emit A2A task status `input-required`.
- Include a typed data part such as:

```ts
{
  type: "approval-request",
  approvalId: "...",
  title: "Send email?",
  description: "...",
  risk: "external-send",
  toolName: "gmail.send",
  inputPreview: {...},
  actions: ["approve", "deny"],
}
```

For elicitation:

```ts
{
  type: "elicitation-request",
  elicitationId: "...",
  title: "Need invoice details",
  schema: {...},
}
```

Then the UI submits a response, and the backend resumes the paused execution.

Do not model this only as a normal tool result. Approval/elicitation is a task lifecycle state, not just another log line.

## 7. Observability And Audit

You have traces and evals, which is good. For business process use, add:

- Immutable audit log for every human/agent/tool decision.
- Correlation IDs: `processRunId`, `taskId`, `contextId`, `approvalId`, `executionId`.
- Actor identity: user, agent, system.
- Before/after payloads for side-effecting API calls, redacted.
- Trace links from UI timeline events.
- Replay/debug view for a workflow run.

## Suggested Order

1. Replace `onElicitation: 'accept-all'` with a real pause/request/resume path.
2. Add typed approval/elicitation events over A2A and render them in the web UI.
3. Persist approval records and workflow run/node run state.
4. Add tool/API policy gates, especially for MCP and POST/PATCH/DELETE.
5. Refactor workflow execution around durable run state and typed process events.
6. Add richer workflow nodes: approval, form input, tool/API, wait, retry, subworkflow.
7. Build a dedicated process run UI: timeline, node graph status, pending human actions, audit trail.
8. Harden secrets/redaction/network policy before connecting important external systems.

## Smallest Vertical Slice

Implement this first:

1. Agent calls MCP/OpenAPI tool.
2. Execution pauses for approval.
3. A2A emits `input-required`.
4. UI shows approval card.
5. User approves.
6. Backend resumes.
7. Workflow continues.
8. Event timeline persists.

That unlocks the core business-process loop.
