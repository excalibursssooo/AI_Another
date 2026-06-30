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
