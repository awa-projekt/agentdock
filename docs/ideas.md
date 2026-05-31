# agentdock

Offers:
- Easy way to create agents
- Keeps track of agents
- Define which agents have which tools (in executor)
- Define which agents can communicate with which agents (via communication tool db)

# TODO

- get one usecase working???
    - sharepoint and email connected
    - access through teams or openwebui
- Observability!
    - Agent information
        - better model info
        - tool info (internal/executor) (ideally + descriptions)
        - instructions (show editable instructions and final instructions (with injected tool info (approx), skills, etc.))
    - tracing
    - better representation of message history
        - find good format
- tracing
    - check what spans might be missing
    - server tracing vs llm tracing
- Elicitation through frontend/a2a
- executor integration
    - endpoints for configuring those executors/permissions/sources
    - add a way to define default tools, that are initially in system message/execute description
    - add a way to disable tools of sources
- UI
    - make home agent available on every page
    - make home agent page aware
    - Update when things change outside of UI (events?)
    - show available tools native/executor better
    - fix 3-way toggle. Laggy
- adding triggers (just internally call a2a endpoints)
    - hooks
    - cron
- Eval
- Skills
    - need to test
    - make it use the implementation from vercel. Current one uses the cli directly
    - run claude over the skills ui (view/edit ugly)
- refactor (v2?)
- context sizes/model info:
    -  https://models.dev/api.json

# Open Questions
- One Agent per User/Admin? vs Each user has different instance of Agent (with slight adjustments, skills/instructions)
- Sources are static rn
    - when added names, inputs, outputs are fixed
    - need to read to refresh
    - probably good behavior for security (connections shouldn't auto change)
    - maybe add "update" button

# Things to fix

- agent added notypecheck markers to some files
    - make it fix it
    - add stricter type checking on project level
- review oauth code
    - agent mentioned oauth fallback
    - oauth seems to be broken
- conversion of routes to web handlers instead of effect
- sources should auto discover possible auth methods probably
    - way less inputs
    - fix buttons (is always "add mcp")
    - should auto detect type of source
- use effect-language-service to check what might be bad code and refactor

# a2a communication tool

- list_agents
    - research_agent | localhost:4001/a2a
    - email_agent | localhost:4004/a2a
- send_task: {"content": "What is the weather in New York?", "agent": "research_agent"}
    - task_id: b7d6901f-3f80-42c8-8f79-2a02d754ea5b
- check_task_status: {"task_id": "b7d6901f-3f80-42c8-8f79-2a02d754ea5b"}
