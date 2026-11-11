# FlowCanvas Worker

Run from the repository root with `uv run --package canvas-worker arq canvas_worker.main.WorkerSettings`.
ARQ job IDs are `agent-run:<AgentRun UUID>`, so duplicate queue submissions are rejected. Agent
run and task state stays in PostgreSQL/SQLite; Redis is only the delivery queue. LangGraph
checkpoints use the same SQLite file in development or PostgreSQL in production.

The worker enables ARQ job aborts. Cancel requests persist the terminal state before signaling
ARQ, and worker writes check that state before saving task or proposal results. ARQ is configured
for up to three attempts using the same LangGraph `thread_id`; when the retry limit is reached, the
worker completion callback marks any still-active run failed so the user can retry it from the UI.
These recovery paths still need verification against a live Redis service and process restart.

Canvas proposals use a checkpointed LangGraph StateGraph with Coordinator, Planner, Canvas Editor,
and Reviewer stages. The Coordinator creates up to three dependency-aware subtasks; independent
editor tasks run in parallel, with role-specific model IDs and the user's saved model as fallback.
The server revalidates every proposed operation against the tool allowlist
(`add_note`, `move_object`). The Reviewer can reject a proposal; only an explicit user apply request
can write accepted operations to the canvas.

Image generation runs as a persisted Image Creator task using the abstract `ImageGenerationProvider`.
Its settings and selected reference images come from the AgentRun; valid outputs are stored as
temporary private assets. The default provider is unconfigured and never makes network requests.
