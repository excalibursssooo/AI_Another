# TypeScript ChatFlow Phase 1-3 Design

## Goal

Implement the compatible-first Phase 1-3 rebuild from `Rebuild.md`: move the active chat path into the existing `ui/` Next.js app with TypeScript server modules, SQLite persistence, and a small explicit ChatFlow. The Python backend remains in the repository as reference only and is no longer used by the main chat path.

## Scope

This phase is intentionally narrow.

In scope:
- Keep the current `ui/` project layout. Do not move the Next.js app to the repository root.
- Add TypeScript server code under `ui/src/server`.
- Add Next.js route handlers under `ui/src/app/api`.
- Use SQLite through Drizzle repositories for the chat path.
- Use `runtime = "nodejs"` for every route that touches SQLite.
- Preserve the existing frontend SSE shape for `POST /chat` through a same-origin `/api/chat` route.
- Provide stubs for frontend APIs that are not part of the Phase 1-3 chat core.
- Seed enough default data for the current UI to load one default world and at least one active agent.
- Add focused tests before implementation.

Out of scope:
- Root directory reorganization.
- Full product rewrite.
- AI agent creation.
- Feed generation.
- Complex world editing.
- Tool calling.
- Authentication rebuild.
- Removing Python files.
- Migrating every old FastAPI route.

## Architecture

The active runtime moves into `ui/`:

```text
ui/src/app/api/*       HTTP and SSE compatibility only
ui/src/server/config   environment parsing
ui/src/server/db       SQLite connection and Drizzle schema
ui/src/server/domain   repositories and small services
ui/src/server/ai       model adapter, schemas, prompt construction
ui/src/server/flow     generic Flow runner and ChatFlow nodes
```

Route handlers are thin. They validate request bodies, call server modules, and translate results to the existing frontend DTOs. They do not contain business logic.

`server/flow` owns orchestration. `ChatFlow` runs explicit nodes:

```text
LoadAgent
LoadWorld
SafetyCheck
LoadRecentMessages
RecallMemories
BuildPrompt
GenerateReply
PersistConversation
ExtractMemory
```

Memory extraction is kept simple in this phase. It can run synchronously after reply generation and must not become a separate job system yet.

## Data Model

SQLite stores the minimum data needed for the Phase 1-3 path:

- `agents`: profile and active status.
- `worlds`: default world metadata.
- `conversations`: one conversation per user and agent.
- `messages`: user and assistant turns.
- `memories`: long-term memory text with importance, confidence, status, and access metadata.
- `agent_live_states`: last mood/risk state for frontend polling.

Repositories expose small methods used by ChatFlow and compatibility routes. They do not call AI code.

## AI Adapter

`server/ai` hides model providers behind a single `generateChatReply` function. The first implementation supports:

- `AI_PROVIDER=mock` for deterministic local tests and development without keys.
- `AI_PROVIDER=deepseek | openai | anthropic | google` through AI SDK provider packages when keys are present.

The generated response uses a Zod schema:

```text
reply: string
mood.label: calm | happy | sad | anxious | angry | focused | neutral | high_risk
mood.intensity: 0..1
mood.heartbeatBpm: 55..130
```

If the provider is unavailable, ChatFlow returns a graceful fallback reply and still persists the conversation.

## API Compatibility

The frontend currently calls paths such as `/chat`, `/agents`, `/conversations`, `/memories`, `/worlds`, and feed-related routes through a configured base URL. This phase changes the client default to same-origin `/api`, then supplies route handlers under `ui/src/app/api`.

Core route:

- `POST /api/chat`: SSE stream with `delta` events and final `done` event matching `ChatDoneEvent`.

Required compatibility routes:

- `GET /api/agents`: return active seeded agents.
- `GET /api/agents/[agentId]/state/live`: return last live state or a default calm state.
- `GET /api/conversations`: return recent turns.
- `GET /api/memories`: return stored memories.
- `GET /api/world/debug`: return default world debug data.
- `GET /api/worlds`: return seeded/default worlds.

Stub routes return stable empty or "not implemented in this phase" responses for non-core APIs needed by existing UI flows. They must not pretend to implement AI creation, feed generation, or complex world editing.

## Error Handling

Routes return JSON errors with a `detail` string. Chat SSE emits a final `done` event for handled model failures where possible. SQLite initialization should create tables and seed defaults lazily so `npm run dev` works without a separate database command.

## Testing

Use Vitest for server modules. Tests are written before production code.

Required coverage:
- Flow runner emits node start/end and propagates context.
- ChatFlow persists user and assistant messages.
- ChatFlow blocks high-risk input without calling the model adapter.
- API client builds same-origin `/api` requests by default.
- Compatibility mapping preserves `ChatDoneEvent` fields.

Manual verification:
- `npm run test:run`
- `npm run lint`
- `npm run build`

## Acceptance Criteria

- `cd ui && npm run dev` starts one Next.js app that serves UI and API.
- The chat page no longer requires FastAPI on port 8000.
- `POST /api/chat` returns SSE `delta` and `done` events with the existing field names.
- Messages are persisted to SQLite.
- `GET /api/conversations` returns persisted turns.
- Non-core routes used by the current UI do not crash the page.
- No root-level project reorganization occurs.
