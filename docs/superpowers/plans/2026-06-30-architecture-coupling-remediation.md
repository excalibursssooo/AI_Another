# Architecture Coupling Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the highest-risk coupling found in `Arch.md` and `Fix.md` by protecting memory data quality first, then tightening request and flow boundaries.

**Architecture:** Keep the current Next.js monolith and lightweight Flow Runner. Make small behavior-preserving or behavior-improving changes behind tests, and commit each segment independently.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, SQLite/better-sqlite3, Drizzle schema definitions, Zod.

---

## Investigation Summary

- `ui/src/server/domain/chat/repositories.ts` is still a 1075-line god file containing Agent, World, Conversation, Memory, LiveState, FeedPost repositories and mappers. This is a real coupling hotspot, but it should be split after data-quality fixes so behavioral risk stays low.
- `ui/src/server/flow/chat-flow.ts` still performs repository construction, safety checks, prompt building, tool configuration via `process.env`, model calls, persistence, live-state updates, task enqueueing, and done-event DTO construction. It should be slimmed after P0 fixes.
- `ui/src/app/api/chat/route.ts` still directly casts `await req.json()` and calls `drainChatTasks()` after chat completion. This keeps HTTP/SSE and worker triggering coupled.
- `TaskRepository.claimNext()` has already improved beyond the older `Fix.md` description: it uses a transaction, lease fields, expired-running recovery, and `result.changes` checking. It is not the first risk to fix.
- `MemoryConsolidator.rankComparable()` returns no candidates when the new embedding is fallback/lexical. That means similar fallback memories currently create duplicates instead of merging or conflict-checking.
- `ConversationRepository.appendMessage()` already returns a message record, but `ChatFlow` discards it. The memory extraction task payload therefore cannot populate `source_message_id` even though `MemoryExtractContext` and `MemoryRepository` already support it.
- `ui/src/server/api/dto.ts` exists, but there is no shared `server/api/request.ts` or request schema module yet.

## Segment 0: Planning and Process Log

**Files:**
- Create: `docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md`

- [x] **Step 1: Confirm current architecture evidence**

Evidence collected with CodeGraph and targeted file inspection:

```text
repositories.ts: 1075 lines
chat-flow.ts: 315 lines
app/api/chat/route.ts: 142 lines
chat-app.tsx: 808 lines
```

- [x] **Step 2: Record implementation order**

Implementation order:

```text
P0-1 Memory fallback deduplication
P0-2 Memory source message id propagation
P1-1 Shared API request parsing and /api/chat schema
P1-2 Repository split by re-export migration
P1-3 ChatFlow prompt/safety/finalizer extraction
```

- [x] **Step 3: Commit segment**

Run:

```bash
git add docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "docs: record architecture remediation plan"
```

Expected: commit created with documentation only.

## Segment 1: Memory Fallback Deduplication

**Files:**
- Modify: `ui/src/server/domain/chat/memory-consolidator.test.ts`
- Modify: `ui/src/server/domain/chat/memory-consolidator.ts`

- [x] **Step 1: Write failing test**

Add a test showing that two fallback-embedding memory candidates with the same `subject`, `memoryType`, and canonical `key` merge into one active memory instead of creating duplicates.

Observed failure:

```text
expected 'created' to be 'merged'
```

- [x] **Step 2: Implement minimal fallback matching**

In `MemoryConsolidator.consolidate()`:

```text
if semantic ranked match exists:
  keep current semantic conflict/merge behavior
else if candidate embedding is fallback/lexical:
  find comparable active memory with same non-empty key
  merge content into that memory
  preserve fallback embedding metadata
else:
  create new memory
```

The first implementation should avoid broad fuzzy matching. Exact key fallback is deterministic, low-risk, and uses fields that already exist.

- [x] **Step 3: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/memory-consolidator.test.ts
```

Expected: memory-consolidator tests pass.

Observed:

```text
Test Files  1 passed (1)
Tests  16 passed (16)
```

- [x] **Step 4: Commit segment**

Run:

```bash
git add ui/src/server/domain/chat/memory-consolidator.ts ui/src/server/domain/chat/memory-consolidator.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "fix: deduplicate fallback memory candidates"
```

## Segment 2: Memory Source Message ID Propagation

**Files:**
- Modify: `ui/src/server/flow/chat-flow.test.ts`
- Modify: `ui/src/server/flow/task-worker.test.ts`
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/flow/task-worker.ts`

- [x] **Step 1: Write failing ChatFlow test**

Assert that the queued `memory_extract` task payload contains the persisted user message id as `sourceMessageId`.

Observed failure:

```text
ChatFlow task payload did not include sourceMessageId.
```

- [x] **Step 2: Write failing TaskWorker test**

Assert that `drainChatTasks()` propagates `sourceMessageId` from task payload into the memory extraction flow, resulting in `memories[0].sourceMessageId` being populated.

Observed failure:

```text
expected null to be 'msg-source-1'
```

- [x] **Step 3: Implement minimal propagation**

In `PersistConversation`, capture:

```ts
const userMessage = conversations.appendMessage(...)
const assistantMessage = conversations.appendMessage(...)
```

Store `sourceMessageId` on `ChatContext`, enqueue it in the memory task payload, parse it in `task-worker.ts`, and pass it through to `createMemoryExtractFlow().run()`.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/flow/chat-flow.test.ts src/server/flow/task-worker.test.ts
```

Observed:

```text
Test Files  2 passed (2)
Tests  10 passed (10)
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/flow/chat-flow.ts ui/src/server/flow/chat-flow.test.ts ui/src/server/flow/task-worker.ts ui/src/server/flow/task-worker.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "fix: propagate memory source message ids"
```

## Segment 3: Shared Chat Request Parsing

**Files:**
- Create: `ui/src/server/api/request.ts`
- Create: `ui/src/server/api/schemas.ts`
- Modify: `ui/src/app/api/chat/route.test.ts`
- Modify: `ui/src/app/api/chat/route.ts`

- [x] **Step 1: Write failing route tests**

Add tests for invalid JSON and blank required chat fields. Expected response status is `400`, and the route must not instantiate flows.

Observed failures:

```text
invalid JSON threw SyntaxError
blank message returned 200 instead of 400
```

- [x] **Step 2: Implement shared parsing**

Create `parseJsonBody(req, schema)` using Zod `safeParse`. Add `ChatRequestSchema` with:

```text
user_id: non-empty string
message: non-empty string
agent_id: non-empty string
domain_id: optional non-empty string
conversation_id: optional non-empty string
client_action_id: optional non-empty string
```

- [x] **Step 3: Refactor /api/chat**

Replace the direct cast in `route.ts` with:

```ts
const body = await parseJsonBody(req, ChatRequestSchema);
```

Preserve current SSE error contract for flow failures.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/app/api/chat/route.test.ts
```

Observed:

```text
Test Files  1 passed (1)
Tests  4 passed (4)
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/api/request.ts ui/src/server/api/schemas.ts ui/src/app/api/chat/route.ts ui/src/app/api/chat/route.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: validate chat request bodies"
```

## Segment 4: Repository Import Boundary Migration

**Files:**
- Create: `ui/src/server/domain/repository-boundaries.test.ts`
- Create: `ui/src/server/domain/agent/agent-repository.ts`
- Create: `ui/src/server/domain/world/world-repository.ts`
- Create: `ui/src/server/domain/conversation/conversation-repository.ts`
- Create: `ui/src/server/domain/memory/memory-repository.ts`
- Create: `ui/src/server/domain/live-state/agent-live-state-repository.ts`
- Create: `ui/src/server/domain/feed/feed-post-repository.ts`
- Modify: callers importing from `@/server/domain/chat/repositories`

- [x] **Step 1: Investigate import surface**

Observed 39 files importing from the legacy god-file path:

```text
@/server/domain/chat/repositories
./repositories
```

Decision: make this a boundary migration first. The new domain modules re-export from the legacy file temporarily; follow-up work can physically move one repository at a time after callers no longer depend on the god-file path.

- [x] **Step 2: Write failing boundary test**

Added `repository-boundaries.test.ts`, which scans `ui/src` and fails if callers import from the legacy repository barrel.

Observed RED:

```text
expected [39 offenders] to deeply equal []
```

- [x] **Step 3: Add domain-specific bridge modules**

Created:

```text
server/domain/agent/agent-repository.ts
server/domain/world/world-repository.ts
server/domain/conversation/conversation-repository.ts
server/domain/memory/memory-repository.ts
server/domain/live-state/agent-live-state-repository.ts
server/domain/feed/feed-post-repository.ts
```

- [x] **Step 4: Migrate caller imports**

Mechanically rewrote callers to import records and repositories from their domain-specific modules. The boundary test intentionally allows only the six temporary bridge modules to depend on `server/domain/chat/repositories`.

- [x] **Step 5: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/repository-boundaries.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
repository-boundaries.test.ts: 1 passed
eslint: passed
Vitest: 47 files, 341 tests passed
Next build: passed
```

- [x] **Step 6: Commit segment**

Run:

```bash
git add ui/src docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: route repository imports through domain modules"
```

## Segment 5: ChatFlow Helper Extraction

**Files:**
- Create: `ui/src/server/domain/chat/chat-safety.ts`
- Create: `ui/src/server/domain/chat/chat-safety.test.ts`
- Create: `ui/src/server/domain/chat/chat-prompt-builder.ts`
- Create: `ui/src/server/domain/chat/chat-prompt-builder.test.ts`
- Create: `ui/src/server/domain/chat/chat-finalizer.ts`
- Create: `ui/src/server/domain/chat/chat-finalizer.test.ts`
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/flow/world-interaction-flow.ts`

- [x] **Step 1: Investigate helper coupling**

`chat-flow.ts` contained private helpers for risk assessment, prompt construction, and done-event DTO construction. `world-interaction-flow.ts` duplicated the same high-risk classifier. Extraction target:

```text
domain/chat/chat-safety.ts
domain/chat/chat-prompt-builder.ts
domain/chat/chat-finalizer.ts
```

- [x] **Step 2: Write failing module tests**

Added tests for:

```text
assessChatRisk()
buildChatSystemPrompt()
buildChatUserPrompt()
finalizeChatContext()
```

Observed RED:

```text
Cannot find module './chat-safety'
Cannot find module './chat-prompt-builder'
Cannot find module './chat-finalizer'
```

- [x] **Step 3: Extract helpers**

Moved helper behavior into domain/chat modules and updated:

```text
chat-flow.ts uses chat-safety, chat-prompt-builder, chat-finalizer
world-interaction-flow.ts uses chat-safety for shared high-risk handling
```

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/chat-safety.test.ts src/server/domain/chat/chat-prompt-builder.test.ts src/server/domain/chat/chat-finalizer.test.ts src/server/flow/chat-flow.test.ts src/server/flow/world-interaction-flow.test.ts
npm run lint
npm run build
npm run test:run
```

Observed:

```text
Targeted tests: 5 files, 23 tests passed
eslint: passed
Next build: passed
Vitest: 50 files, 347 tests passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/domain/chat ui/src/server/flow/chat-flow.ts ui/src/server/flow/world-interaction-flow.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: extract chat flow helpers"
```

## Segment 6: Agent and World Repository Physical Split

**Files:**
- Modify: `ui/src/server/domain/repository-boundaries.test.ts`
- Modify: `ui/src/server/domain/agent/agent-repository.ts`
- Modify: `ui/src/server/domain/world/world-repository.ts`
- Modify: `ui/src/server/domain/chat/repositories.ts`

- [x] **Step 1: Investigate dependencies**

`AgentRepository` and `WorldRepository` only depended on:

```text
randomUUID
AppDatabase
parseStringArray
```

They had no dependency on memory, conversation, feed, or live-state repositories, so they were the safest first physical split.

- [x] **Step 2: Tighten boundary test**

Updated `repository-boundaries.test.ts` so `server/domain/agent/agent-repository.ts` and `server/domain/world/world-repository.ts` may no longer import from `server/domain/chat/repositories`.

Observed RED:

```text
server/domain/agent/agent-repository.ts
server/domain/world/world-repository.ts
```

- [x] **Step 3: Move implementations**

Moved these into domain-specific modules:

```text
AgentRecord
AgentRepository
WorldRecord
WorldRepository
```

`server/domain/chat/repositories.ts` now re-exports Agent/World for compatibility, but no longer owns their implementation.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/repository-boundaries.test.ts src/server/domain/chat/repositories.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted tests: 2 files, 17 tests passed
eslint: passed
Vitest: 50 files, 347 tests passed
Next build: passed
repositories.ts: 851 lines
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/domain/agent/agent-repository.ts ui/src/server/domain/world/world-repository.ts ui/src/server/domain/chat/repositories.ts ui/src/server/domain/repository-boundaries.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: split agent and world repositories"
```

## Segment 7: Conversation Repository Physical Split

**Files:**
- Modify: `ui/src/server/domain/repository-boundaries.test.ts`
- Modify: `ui/src/server/domain/conversation/conversation-repository.ts`
- Modify: `ui/src/server/domain/chat/repositories.ts`

- [x] **Step 1: Investigate dependencies**

`ConversationRepository` only depended on:

```text
randomUUID
AppDatabase
MessageRow/mapMessage
```

It had no dependency on Memory, Feed, Agent, World, or LiveState implementations.

- [x] **Step 2: Tighten boundary test**

Updated `repository-boundaries.test.ts` so `server/domain/conversation/conversation-repository.ts` may no longer import from `server/domain/chat/repositories`.

Observed RED:

```text
server/domain/conversation/conversation-repository.ts
```

- [x] **Step 3: Move implementation**

Moved these into `server/domain/conversation/conversation-repository.ts`:

```text
ConversationMessageRecord
ConversationRepository
MessageRow
mapMessage
```

`server/domain/chat/repositories.ts` now re-exports Conversation for compatibility, but no longer owns its implementation.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/repository-boundaries.test.ts src/server/domain/chat/repositories.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted tests: 2 files, 17 tests passed
eslint: passed
Vitest: 50 files, 347 tests passed
Next build: passed
repositories.ts: 751 lines
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/domain/conversation/conversation-repository.ts ui/src/server/domain/chat/repositories.ts ui/src/server/domain/repository-boundaries.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: split conversation repository"
```

## Segment 8: Live State and Feed Repository Physical Split

**Files:**
- Modify: `ui/src/server/domain/repository-boundaries.test.ts`
- Modify: `ui/src/server/domain/live-state/agent-live-state-repository.ts`
- Modify: `ui/src/server/domain/feed/feed-post-repository.ts`
- Modify: `ui/src/server/domain/chat/repositories.ts`

- [x] **Step 1: Investigate dependencies**

`AgentLiveStateRepository` and `FeedPostRepository` were independent of memory consolidation and only depended on:

```text
AppDatabase
randomUUID for feed posts
local row mappers
```

- [x] **Step 2: Tighten boundary test**

Updated `repository-boundaries.test.ts` so live-state and feed modules may no longer import from `server/domain/chat/repositories`.

Observed RED:

```text
server/domain/feed/feed-post-repository.ts
server/domain/live-state/agent-live-state-repository.ts
```

- [x] **Step 3: Move implementations**

Moved these into domain-specific modules:

```text
AgentLiveStateRecord
AgentLiveStateRepository
FeedPostRecord
FeedPostRepository
FeedPostRow
mapFeedPost
```

`server/domain/chat/repositories.ts` now re-exports live-state and feed for compatibility, but no longer owns their implementation.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/repository-boundaries.test.ts src/server/domain/chat/repositories.test.ts src/server/flow/feed-flow.test.ts src/server/flow/chat-flow.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted tests: 4 files, 34 tests passed
eslint: passed
Vitest: 50 files, 347 tests passed
Next build: passed
repositories.ts: 549 lines
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/domain/live-state/agent-live-state-repository.ts ui/src/server/domain/feed/feed-post-repository.ts ui/src/server/domain/chat/repositories.ts ui/src/server/domain/repository-boundaries.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: split live state and feed repositories"
```

## Segment 9: Memory Repository Physical Split

**Files:**
- Modify: `ui/src/server/domain/repository-boundaries.test.ts`
- Modify: `ui/src/server/domain/memory/memory-repository.ts`
- Modify: `ui/src/server/domain/chat/repositories.ts`

- [x] **Step 1: Investigate dependencies**

After earlier splits, `server/domain/chat/repositories.ts` contained only Memory implementation plus compatibility re-exports. `MemoryRepository` depended on:

```text
randomUUID
AppDatabase
MemoryRow
MemoryEmbeddingInput
CreateMemoryInput
mapMemory
scoreMemory / computeTextScore / countOccurrences
```

- [x] **Step 2: Tighten boundary test**

Updated `repository-boundaries.test.ts` so `server/domain/memory/memory-repository.ts` may no longer import from `server/domain/chat/repositories`.

Observed RED:

```text
server/domain/memory/memory-repository.ts
```

- [x] **Step 3: Move implementation**

Moved these into `server/domain/memory/memory-repository.ts`:

```text
MemoryRecord
MemoryRepository
MemoryRow
MemoryEmbeddingInput
CreateMemoryInput
mapMemory
scoreMemory
computeTextScore
countOccurrences
```

`server/domain/chat/repositories.ts` is now a 12-line compatibility barrel only.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/repository-boundaries.test.ts src/server/domain/chat/repositories.test.ts src/server/domain/chat/memory-consolidator.test.ts src/server/flow/memory-extract-flow.test.ts src/server/flow/task-worker.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted tests: 5 files, 41 tests passed
eslint: passed
Vitest: 50 files, 347 tests passed
Next build: passed
repositories.ts: 12 lines
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/domain/memory/memory-repository.ts ui/src/server/domain/chat/repositories.ts ui/src/server/domain/repository-boundaries.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: split memory repository"
```

## Segment 10: Decouple Chat Route From Task Draining

**Files:**
- Modify: `ui/src/app/api/chat/route.ts`
- Modify: `ui/src/app/api/chat/route.test.ts`
- Create: `ui/src/app/api/internal/tasks/drain/route.ts`
- Create: `ui/src/app/api/internal/tasks/drain/route.test.ts`
- Modify: `ui/src/server/api/schemas.ts`

- [x] **Step 1: Investigate current coupling**

`/api/chat` still imported `drainChatTasks()` and invoked it after emitting the chat SSE done event:

```ts
void drainChatTasks({ db }).catch(() => undefined);
```

No `/api/internal/tasks/drain` route existed. Existing worker code was already isolated in `server/flow/task-worker.ts`, so the low-risk change was to remove the route-side drain and add an explicit internal drain endpoint.

- [x] **Step 2: Write failing tests**

Added:

```text
/api/chat standard branch returns SSE without calling drainChatTasks
/api/internal/tasks/drain POST calls drainChatTasks explicitly
```

Observed RED:

```text
/api/chat called drainChatTasks once
/api/internal/tasks/drain route module did not exist
```

- [x] **Step 3: Implement explicit drain endpoint**

Changes:

```text
/api/chat no longer imports or calls drainChatTasks
/api/internal/tasks/drain accepts { limit?: number }
DrainTasksRequestSchema validates limit as int 0..100
internal route returns drainChatTasks() result JSON
```

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/app/api/chat/route.test.ts src/app/api/internal/tasks/drain/route.test.ts
npm run lint
npm run build
npm run test:run
```

Observed:

```text
Targeted tests: 2 files, 6 tests passed
eslint: passed
Next build: passed and listed /api/internal/tasks/drain
Vitest: 51 files, 349 tests passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/app/api/chat/route.ts ui/src/app/api/chat/route.test.ts ui/src/app/api/internal/tasks/drain/route.ts ui/src/app/api/internal/tasks/drain/route.test.ts ui/src/server/api/schemas.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: drain chat tasks explicitly"
```

## Segment 11: Structured AI Failure Observability

**Files:**
- Modify: `ui/src/server/ai/structured-output.ts`
- Modify: `ui/src/server/ai/structured-output.test.ts`
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/ai/chat.test.ts`

- [x] **Step 1: Investigate error swallowing**

`StructuredOutputError` only carried `schemaName`. It lost:

```text
model unavailable vs generateText failure vs missing output
original generateText error cause
```

The draft/memory/feed generators also caught errors and returned fallback/null without any structured warning.

- [x] **Step 2: Write failing tests**

Added expectations that:

```text
StructuredOutputError.reason is "missing_output" for undefined output
StructuredOutputError.reason is "generate_text_failed" for AI SDK failures
StructuredOutputError.cause preserves the original generateText error
generateAgentDraft logs a structured fallback warning before returning null
```

Observed RED:

```text
StructuredOutputError missing reason/cause
console.warn was not called for generateAgentDraft fallback
```

- [x] **Step 3: Implement structured failure details**

Changes:

```text
StructuredOutputError.reason:
  model_unavailable | generate_text_failed | missing_output
StructuredOutputError.cause preserves caught generateText error
logAiGenerationFallback emits [ai-generation] JSON warnings
chat fallback logs fallback_reply
agent/world/memory/feed null fallbacks log fallback_null
```

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/ai/structured-output.test.ts src/server/ai/chat.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted tests: 2 files, 47 tests passed
eslint: passed
Vitest: 51 files, 349 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/ai/structured-output.ts ui/src/server/ai/structured-output.test.ts ui/src/server/ai/chat.ts ui/src/server/ai/chat.test.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "chore: log structured ai fallback reasons"
```

## Segment 12: Database Schema Drift Guard

**Files:**
- Add: `ui/src/server/db/schema-drift.test.ts`
- Modify: `ui/src/server/db/schema.ts`

- [x] **Step 1: Investigate schema double truth**

The database layer still has two sources of structure:

```text
ui/src/server/db/schema.ts: Drizzle table/column declarations for typed ORM access
ui/src/server/db/client.ts: handwritten CREATE TABLE, indexes, virtual tables, and ALTER TABLE migrations
```

This segment does not replace the migration system. It adds a guard that fails when `schema.ts` declares a table or column that `initializeDatabase` does not actually create.

- [x] **Step 2: Write failing test**

Added `schema-drift.test.ts`:

```text
reflect every Drizzle table name with getTableName
reflect every Drizzle column name with getTableColumns
initialize an in-memory SQLite database
assert every schema table and column exists after initialization
```

Observed RED:

```text
memories_fts.rowid exists after initializeDatabase:
expected [ 'content' ] to include 'rowid'
```

- [x] **Step 3: Fix current drift**

`memories_fts` is created as an FTS5 virtual table with visible `content` only. SQLite still allows rowid-based joins and trigger writes, but `rowid` is not a declared visible table column. Removed `rowid` from the Drizzle schema declaration so `schema.ts` matches the initialized database shape.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/server/db/schema-drift.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted drift guard: 1 file, 1 test passed
eslint: passed
Vitest: 52 files, 350 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/server/db/schema-drift.test.ts ui/src/server/db/schema.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "test: guard database schema drift"
```

## Segment 13: Extract Chat Right Panel

**Files:**
- Add: `ui/src/features/chat/components/RightPanel.tsx`
- Add: `ui/src/features/chat/components/RightPanel.test.tsx`
- Modify: `ui/src/features/chat/chat-app.tsx`

- [x] **Step 1: Investigate frontend coupling**

`ChatApp` still owned several unrelated responsibilities:

```text
message sending and streaming state
agent creation flow state
world/domain settings
feed loading and trigger actions
right-side state/feed/add-friend presentation
telemetry effects
```

Existing child components already split `ChatArea`, `ChatSidebar`, `CreationOverlay`, and `WorldManager`. The right-side panel was the clearest remaining UI block that could be extracted without changing data flow or API behavior.

- [x] **Step 2: Write failing component test**

Added `RightPanel.test.tsx` with `react-dom/server` rendering because the project does not currently use React Testing Library.

The test covers:

```text
state tab renders selected agent mood, heartbeat, and risk fields
feed tab renders generate button and post cards
add-friend menu renders both creation choices without store dependencies
```

Observed RED:

```text
Cannot find module './RightPanel'
```

- [x] **Step 3: Extract controlled RightPanel component**

Changes:

```text
RightPanel owns right-side state/feed/add-friend JSX
ChatApp passes state and event callbacks as props
RightPanel has no Zustand store dependency
RightPanel has no API dependency
ChatApp keeps data loading, mutation handlers, and creation flow orchestration
```

During lint verification, React's refs rule rejected passing a `RefObject` through a broad props object. The component now accepts a callback ref (`onVitalsContainerElement`) and `StatePanel` has a narrowed prop interface so the ref boundary is explicit.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/features/chat/components/RightPanel.test.tsx
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted RightPanel tests: 1 file, 3 tests passed
eslint: passed
Vitest: 53 files, 353 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/features/chat/chat-app.tsx ui/src/features/chat/components/RightPanel.tsx ui/src/features/chat/components/RightPanel.test.tsx docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: extract chat right panel"
```

## Segment 14: Validate Agent Create Request Bodies

**Files:**
- Add: `ui/src/app/api/agents/route.test.ts`
- Modify: `ui/src/app/api/agents/route.ts`
- Modify: `ui/src/server/api/schemas.ts`

- [x] **Step 1: Investigate route parsing drift**

Search showed `request.json()` is still used directly in several routes:

```text
memories/[memoryId]
memories/[memoryId]/freeze
memories/[memoryId]/activate
worlds
worlds/[worldId]
worlds/ai-create
agents
agents/[agentId]
agents/[agentId]/generate-post
agents/[agentId]/memory-seed/debug
agents/ai-create
```

`/api/agents` POST was selected for this segment because it creates user-visible agents and still used a type assertion plus a handwritten `name/persona` check.

- [x] **Step 2: Write failing tests**

Added `/api/agents` route validation tests for:

```text
invalid JSON returns { error: "invalid_json" } before creating the flow
blank required fields return { error: "invalid_request" } before creating the flow
```

Observed RED:

```text
invalid JSON threw SyntaxError
blank fields returned legacy { detail: "name and persona are required" }
```

- [x] **Step 3: Implement schema-backed parsing**

Changes:

```text
AgentCreateRequestSchema added to server/api/schemas.ts
/api/agents POST now uses parseJsonBody
ApiRequestError is converted with apiRequestErrorResponse
name and persona are non-empty trimmed strings
background, domain_id, speaking_style preserve existing optional default behavior
hobbies must be a string array when provided
```

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/app/api/agents/route.test.ts
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted /api/agents tests: 1 file, 2 tests passed
eslint: passed
Vitest: 54 files, 355 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/app/api/agents/route.ts ui/src/app/api/agents/route.test.ts ui/src/server/api/schemas.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: validate agent create requests"
```

## Segment 15: Validate World Upsert Request Bodies

**Files:**
- Add: `ui/src/app/api/worlds/route.test.ts`
- Add: `ui/src/app/api/worlds/[worldId]/route.test.ts`
- Modify: `ui/src/app/api/worlds/route.ts`
- Modify: `ui/src/app/api/worlds/[worldId]/route.ts`
- Modify: `ui/src/server/api/schemas.ts`

- [x] **Step 1: Investigate route parsing drift**

After Segment 14, direct `request.json()` remained in 10 routes. `/api/worlds` POST and `/api/worlds/[worldId]` PUT were selected because both accept the same manual world upsert payload and both used type assertions plus handwritten `name` checks.

- [x] **Step 2: Write failing tests**

Added tests for both world create and world update:

```text
invalid JSON returns { error: "invalid_json" } before creating the flow
blank name returns { error: "invalid_request" } before creating the flow
non-array constraints / seed_memories are rejected by schema
```

Observed RED:

```text
invalid JSON threw SyntaxError
blank name returned legacy { detail: "name is required" }
```

- [x] **Step 3: Implement schema-backed parsing**

Changes:

```text
WorldUpsertRequestSchema added to server/api/schemas.ts
/api/worlds POST now uses parseJsonBody
/api/worlds/[worldId] PUT now uses parseJsonBody
ApiRequestError is converted with apiRequestErrorResponse
name is a non-empty trimmed string
constraints and seed_memories must be string arrays when provided
```

Existing default behavior is preserved for optional `lore`, `tone`, `constraints`, and `seed_memories` in the flow input.

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- src/app/api/worlds/route.test.ts 'src/app/api/worlds/[worldId]/route.test.ts'
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted world route tests: 2 files, 4 tests passed
eslint: passed
Vitest: 56 files, 359 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/app/api/worlds/route.ts ui/src/app/api/worlds/route.test.ts ui/src/app/api/worlds/[worldId]/route.ts ui/src/app/api/worlds/[worldId]/route.test.ts ui/src/server/api/schemas.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: validate world upsert requests"
```

## Segment 16: Validate Agent Update Request Bodies

**Files:**
- Add: `ui/src/app/api/agents/[agentId]/route.test.ts`
- Modify: `ui/src/app/api/agents/[agentId]/route.ts`
- Modify: `ui/src/server/api/schemas.ts`

- [x] **Step 1: Investigate update route behavior**

`/api/agents/[agentId]` PUT still parsed JSON directly and opened the database before parsing the body. Its `status` field was only constrained by a TypeScript assertion, so invalid runtime values could proceed into the repository update path.

- [x] **Step 2: Write failing tests**

Added validation tests for:

```text
invalid JSON returns { error: "invalid_json" } before opening the database
invalid status returns { error: "invalid_request" } before opening the database
```

Observed RED:

```text
invalid JSON threw SyntaxError
invalid status reached AgentRepository.update and failed against the mocked db
```

- [x] **Step 3: Implement schema-backed parsing**

Changes:

```text
AgentUpdateRequestSchema added to server/api/schemas.ts
/api/agents/[agentId] PUT parses before getDatabase()
status is restricted to active | inactive
ApiRequestError is converted with apiRequestErrorResponse
existing partial-update semantics are preserved for optional fields
```

- [x] **Step 4: Verify**

Run:

```bash
cd ui
npm run test:run -- 'src/app/api/agents/[agentId]/route.test.ts'
npm run lint
npm run test:run
npm run build
```

Observed:

```text
Targeted /api/agents/[agentId] tests: 1 file, 2 tests passed
eslint: passed
Vitest: 57 files, 361 tests passed
Next build: passed
```

- [x] **Step 5: Commit segment**

Run:

```bash
git add ui/src/app/api/agents/[agentId]/route.ts ui/src/app/api/agents/[agentId]/route.test.ts ui/src/server/api/schemas.ts docs/superpowers/plans/2026-06-30-architecture-coupling-remediation.md
git commit -m "refactor: validate agent update requests"
```

## Verification Gates

After every segment:

```bash
git status --short
```

Before declaring the goal complete:

```bash
cd ui
npm run test:run
npm run lint
npm run build
npm run smoke:chat
```

If full verification is too slow or blocked by external model configuration, record the exact failure output and keep the goal open.
