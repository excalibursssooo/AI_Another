# WorldMind Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the long-running WorldMind loop: leased world tick tasks, idempotent scheduled tick execution, actor command workers, and secondary world memory consolidation.

**Architecture:** Phase 4 keeps the Phase 1-3 invariant that `WorldMindFlow` is the only primary writer for world events, snapshots, character states, actor commands, and decision logs. Task execution, memory consolidation, next tick scheduling, and actor command execution are secondary effects that run after committed world state exists; if they fail, they do not roll back committed events. Workers use task leases and command leases so retries are inspectable and idempotent.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, better-sqlite3, Drizzle schema definitions, SQLite, existing AI SDK embeddings, existing Flow runner.

---

## Phase 4 Scope

Implement:

- Task queue lease, idempotency, bounded retry, permanent failure, and expired lock recovery.
- `world_summaries` table with visibility ACL fields for future context compression.
- `WorldMemoryConsolidator` with type-specific strategies for `rule`, `secret`, `relationship`, `unresolved_thread`, and `lore`.
- Secondary WorldMind effects after the core transaction: memory consolidation and next tick scheduling.
- `world_tick_worker` for leased, idempotent `world_tick` tasks.
- `ActorCommandWorker` for `move_location`, `investigate`, `remember`, `initiate_event`, and `publish_post` command execution.
- Result events for state-changing command effects before reducers update state.

Do not implement:

- A full simulation engine, economy, pathfinding, combat, or calendars.
- Multi-process distributed locking beyond SQLite atomic updates.
- LLM-direct state mutation.
- Reuse of actor/user summaries as director-hidden summaries.

## Current State To Preserve

Phase 1-3 already provide:

- `world_events`, `world_state_snapshots`, `world_runs`, `character_states`, `actor_commands`, `world_decision_logs`, and `world_memories`.
- `WorldMindDecisionSchema`, `worldDirector`, `world_context_builder`, and `world_decision_validator`.
- `WorldMindFlow` accepted/rejected/model_failed/transaction_failed paths.
- `WorldInteractionFlow` with strict world loading, `client_action_id`, and visible `speak_to_user` directive injection.
- `ActorCommandRepository.claimVisibleSpeakCommand` for chat prompt directives.

Do not replace those files wholesale. Extend them in place unless a new file has a distinct responsibility.

## File Structure

Create:

- `ui/src/server/db/tables-world-phase4.test.ts`  
  Tests task lease columns and `world_summaries` schema.
- `ui/src/server/domain/chat/task-repository-lease.test.ts`  
  Tests idempotent enqueue, atomic claim, lock expiry, retry backoff, and permanent failure.
- `ui/src/server/domain/world/world-memory-consolidator.ts`  
  Owns Phase 4 world memory consolidation and embedding enrichment.
- `ui/src/server/domain/world/world-memory-consolidator.test.ts`  
  Tests type-specific world memory merge and supersession behavior.
- `ui/src/server/flow/world-mind-secondary-effects.test.ts`  
  Tests memory consolidation and tick scheduling happen after accepted commits and do not run for rejected/model_failed runs.
- `ui/src/server/flow/world-tick-worker.ts`  
  Claims `world_tick` tasks, creates scheduled tick envelopes, runs WorldMind, marks tasks done/failed, and relies on task idempotency for retries.
- `ui/src/server/flow/world-tick-worker.test.ts`  
  Tests leased tick execution, idempotent retry, quiet-world behavior, and failure retry.
- `ui/src/server/flow/actor-command-worker.ts`  
  Claims non-chat actor commands, writes command result world events, runs reducers, and completes/fails commands.
- `ui/src/server/flow/actor-command-worker.test.ts`  
  Tests `move_location`, `remember`, `investigate`, `initiate_event`, and `publish_post`.
- `ui/src/server/flow/world-loop-integration.test.ts`  
  Tests user action -> accepted decision -> scheduled tick -> actor command execution without duplicated events.

Modify:

- `ui/src/server/db/client.ts`  
  Adds task lease migrations and `world_summaries` runtime table.
- `ui/src/server/db/schema.ts`  
  Adds Drizzle fields for task leasing and `worldSummaries`.
- `ui/src/server/domain/chat/task-repository.ts`  
  Adds idempotent enqueue, atomic claim, lock metadata, retry backoff, and permanent failure.
- `ui/src/server/flow/task-worker.ts`  
  Passes worker id and lease options to the upgraded task repository for existing `memory_extract` work.
- `ui/src/server/domain/world/types.ts`  
  Adds world summary, memory consolidation, and command execution result types.
- `ui/src/server/domain/world/world-memory-repository.ts`  
  Adds supersession and canonical-key lookup helpers used by the consolidator.
- `ui/src/server/flow/world-mind-flow.ts`  
  Runs `ConsolidateWorldMemorySecondary` and `ScheduleNextTickSecondary` after accepted commits only.
- `ui/src/server/domain/world/actor-command-repository.ts`  
  Adds worker command claim, done/failed/expired helpers, and public read helpers.
- `ui/src/server/domain/world/world-event-repository.ts`  
  Reuses `createCommitted` for command-result events; no schema-level command event link is added in Phase 4.
- `ui/src/server/domain/world/world-state-repository.ts`  
  Reused by workers to save latest snapshots after command-result events.
- `ui/src/server/flow/feed-flow.ts`  
  Reused by `ActorCommandWorker` for `publish_post` command execution.

---

### Task 1: Add Phase 4 Database Shape

**Files:**
- Create: `ui/src/server/db/tables-world-phase4.test.ts`
- Modify: `ui/src/server/db/client.ts`
- Modify: `ui/src/server/db/schema.ts`

- [ ] **Step 1: Write failing table and migration tests**

Create `ui/src/server/db/tables-world-phase4.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "./client";

function columns(table: string): string[] {
  const db = createTestDatabase();
  return (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function indexes(table: string): string[] {
  const db = createTestDatabase();
  return (db.sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((index) => index.name);
}

describe("world phase 4 database shape", () => {
  it("adds task lease, idempotency, retry, and permanent failure columns", () => {
    expect(columns("tasks")).toEqual(
      expect.arrayContaining([
        "idempotency_key",
        "locked_by",
        "locked_at",
        "lock_expires_at",
        "max_attempts",
        "next_attempt_at",
        "completed_at",
        "failed_permanently_at",
      ]),
    );
    expect(indexes("tasks")).toEqual(
      expect.arrayContaining(["tasks_idempotency_uidx", "tasks_claim_idx"]),
    );
  });

  it("creates world_summaries with visibility ACL fields", () => {
    expect(columns("world_summaries")).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "world_id",
        "summary_scope",
        "subject_type",
        "subject_key",
        "content",
        "visibility",
        "visible_to_actor_ids_json",
        "visible_to_user",
        "source_event_sequence_from",
        "source_event_sequence_to",
        "created_at",
        "updated_at",
      ]),
    );
    expect(indexes("world_summaries")).toContain("world_summaries_scope_idx");
  });
});
```

- [ ] **Step 2: Run the failing database tests**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase4.test.ts
```

Expected: fail because `tasks` lacks lease columns and `world_summaries` does not exist.

- [ ] **Step 3: Add runtime task lease migration**

In `ui/src/server/db/client.ts`, call this after `migrateAgentLiveStatesScope(db);`:

```typescript
  migrateTaskLeaseColumns(db);
```

Add:

```typescript
function migrateTaskLeaseColumns(db: AppDatabase): void {
  const columns = db.sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const addColumn = (name: string, definition: string) => {
    if (!names.has(name)) {
      db.sqlite.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      names.add(name);
    }
  };

  addColumn("idempotency_key", "TEXT");
  addColumn("locked_by", "TEXT");
  addColumn("locked_at", "INTEGER");
  addColumn("lock_expires_at", "INTEGER");
  addColumn("max_attempts", "INTEGER NOT NULL DEFAULT 3");
  addColumn("next_attempt_at", "INTEGER");
  addColumn("completed_at", "INTEGER");
  addColumn("failed_permanently_at", "INTEGER");

  db.sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_uidx
      ON tasks(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tasks_claim_idx
      ON tasks(status, kind, next_attempt_at, run_after, lock_expires_at);
  `);
}
```

Update the fresh `tasks` table definition inside `initializeDatabase` with:

```sql
      idempotency_key TEXT,
      locked_by TEXT,
      locked_at INTEGER,
      lock_expires_at INTEGER,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at INTEGER,
      completed_at INTEGER,
      failed_permanently_at INTEGER,
```

- [ ] **Step 4: Add `world_summaries` table**

Inside the `initializeDatabase` SQL block, add:

```sql
    CREATE TABLE IF NOT EXISTS world_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      summary_scope TEXT NOT NULL CHECK (summary_scope IN ('director', 'actor', 'user')),
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'hidden')),
      visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      visible_to_user INTEGER NOT NULL DEFAULT 0,
      source_event_sequence_from INTEGER NOT NULL,
      source_event_sequence_to INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS world_summaries_scope_idx
      ON world_summaries(user_id, world_id, summary_scope, subject_type, subject_key, source_event_sequence_to DESC);
```

- [ ] **Step 5: Add Drizzle schema fields**

In `ui/src/server/db/schema.ts`, add these fields to `tasks`:

```typescript
  idempotencyKey: text("idempotency_key"),
  lockedBy: text("locked_by"),
  lockedAt: integer("locked_at"),
  lockExpiresAt: integer("lock_expires_at"),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextAttemptAt: integer("next_attempt_at"),
  completedAt: integer("completed_at"),
  failedPermanentlyAt: integer("failed_permanently_at"),
```

Add:

```typescript
export const worldSummaries = sqliteTable("world_summaries", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  worldId: text("world_id").notNull(),
  summaryScope: text("summary_scope").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  content: text("content").notNull(),
  visibility: text("visibility").notNull(),
  visibleToActorIdsJson: text("visible_to_actor_ids_json").notNull().default("[]"),
  visibleToUser: integer("visible_to_user").notNull().default(0),
  sourceEventSequenceFrom: integer("source_event_sequence_from").notNull(),
  sourceEventSequenceTo: integer("source_event_sequence_to").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase4.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/db/client.ts ui/src/server/db/schema.ts ui/src/server/db/tables-world-phase4.test.ts
git commit -m "feat(world): add phase 4 task lease schema"
```

### Task 2: Upgrade TaskRepository For Lease, Idempotency, And Backoff

**Files:**
- Create: `ui/src/server/domain/chat/task-repository-lease.test.ts`
- Modify: `ui/src/server/domain/chat/task-repository.ts`
- Modify: `ui/src/server/flow/task-worker.ts`
- Modify: `ui/src/server/flow/task-worker.test.ts`

- [ ] **Step 1: Write failing lease tests**

Create `ui/src/server/domain/chat/task-repository-lease.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "./task-repository";

describe("TaskRepository lease behavior", () => {
  it("returns the existing task for duplicate idempotency keys", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const first = tasks.enqueue({
      kind: "world_tick",
      payload: { worldId: "default" },
      idempotencyKey: "tick:default:1",
    });
    const second = tasks.enqueue({
      kind: "world_tick",
      payload: { worldId: "default", ignored: true },
      idempotencyKey: "tick:default:1",
    });
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ worldId: "default" });
  });

  it("claims a due task with a worker lease and does not claim it again before expiry", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" } });
    const claimed = tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockedBy).toBe("worker-a");
    expect(tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-b", leaseMs: 30_000 })).toBeNull();
  });

  it("reclaims a running task after the lock expires", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" } });
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 1 });
    db.sqlite.prepare("UPDATE tasks SET lock_expires_at = ? WHERE id = ?").run(Date.now() - 1_000, task.id);
    const reclaimed = tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-b", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(task.id);
    expect(reclaimed?.lockedBy).toBe("worker-b");
  });

  it("retries failed tasks with bounded backoff before permanent failure", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" }, maxAttempts: 2 });
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    const firstFailure = tasks.markFailed(task.id, "first failure");
    expect(firstFailure?.status).toBe("pending");
    expect(firstFailure?.attempts).toBe(1);
    expect(firstFailure?.nextAttemptAt).toBeGreaterThan(Date.now());

    db.sqlite.prepare("UPDATE tasks SET next_attempt_at = ? WHERE id = ?").run(Date.now() - 1, task.id);
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    const permanent = tasks.markFailed(task.id, "second failure");
    expect(permanent?.status).toBe("failed");
    expect(permanent?.attempts).toBe(2);
    expect(permanent?.failedPermanentlyAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/chat/task-repository-lease.test.ts
```

Expected: fail because `TaskRecord` and repository methods do not expose lease fields or idempotent enqueue.

- [ ] **Step 3: Extend task types**

In `ui/src/server/domain/chat/task-repository.ts`, update `TaskRecord`:

```typescript
export interface TaskRecord {
  id: string;
  kind: string;
  payload: unknown;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  runAfter: number;
  idempotencyKey: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
  lockExpiresAt: number | null;
  maxAttempts: number;
  nextAttemptAt: number | null;
  completedAt: number | null;
  failedPermanentlyAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

Update `TaskRow` with matching snake_case fields and update `mapTask`.

- [ ] **Step 4: Replace enqueue with idempotent enqueue**

Change the signature:

```typescript
  enqueue(input: {
    kind: string;
    payload: unknown;
    runAfter?: number;
    idempotencyKey?: string | null;
    maxAttempts?: number;
  }): TaskRecord
```

Implementation rules:

- If `idempotencyKey` is present and a row exists, return it.
- Insert `next_attempt_at = runAfter`.
- Use `maxAttempts ?? 3`.
- On unique constraint race, re-read by idempotency key and return the existing row.

Add public:

```typescript
  getByIdempotencyKey(idempotencyKey: string): TaskRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM tasks WHERE idempotency_key = ?")
      .get(idempotencyKey) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
```

- [ ] **Step 5: Replace `claimNext` with atomic lease claim**

Change the signature:

```typescript
  claimNext(opts?: { kinds?: string[]; workerId?: string; leaseMs?: number }): TaskRecord | null
```

Implementation rules:

- Claim `pending` tasks whose `run_after` and `COALESCE(next_attempt_at, run_after)` are due.
- Reclaim `running` tasks only when `lock_expires_at <= now`.
- Set `status = 'running'`, `locked_by`, `locked_at`, and `lock_expires_at`.
- Run select and update in one SQLite transaction.
- Return `null` when no row can be atomically updated.

- [ ] **Step 6: Update completion and failure semantics**

`markDone(id)` must set:

```text
status = 'done'
locked_by = NULL
locked_at = NULL
lock_expires_at = NULL
completed_at = now
updated_at = now
```

`markFailed(id, error)` must:

- Increment `attempts`.
- If `attempts < max_attempts`, set `status = 'pending'`, clear lock fields, and set `next_attempt_at` with exponential backoff.
- If `attempts >= max_attempts`, set `status = 'failed'`, clear lock fields, set `failed_permanently_at = now`, and keep row inspectable.

- [ ] **Step 7: Keep existing memory worker compatible**

In `ui/src/server/flow/task-worker.ts`, update the claim call:

```typescript
const task = tasks.claimNext({
  kinds: ["memory_extract"],
  workerId: "chat-task-worker",
  leaseMs: 60_000,
});
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/chat/task-repository.test.ts src/server/domain/chat/task-repository-lease.test.ts src/server/flow/task-worker.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/domain/chat/task-repository.ts ui/src/server/domain/chat/task-repository.test.ts ui/src/server/domain/chat/task-repository-lease.test.ts ui/src/server/flow/task-worker.ts ui/src/server/flow/task-worker.test.ts
git commit -m "feat(tasks): add leased idempotent task queue"
```

### Task 3: Add Actor Command Worker Repository Helpers

**Files:**
- Modify: `ui/src/server/domain/world/actor-command-repository.ts`
- Modify: `ui/src/server/domain/world/actor-command-repository.test.ts`

- [ ] **Step 1: Add test helper**

In `ui/src/server/domain/world/actor-command-repository.test.ts`, add this helper:

```typescript
function makeCommand(overrides: Partial<CreateActorCommandInput> = {}): CreateActorCommandInput {
  const now = Date.now();
  return {
    decisionId: "wdec-test",
    worldRunId: "wrun-test",
    userId: "u001",
    worldId: "default",
    targetAgentId: "agent-default",
    commandType: "move_location",
    priority: "normal",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    actorInstruction: "Move to the square.",
    privateReason: null,
    cause: { type: "director_no_event", reasonCode: "test" },
    payload: { locationKey: "square" },
    relatedEventId: null,
    runAfter: now,
    expiresAt: null,
    idempotencyKey: "cmd:test",
    ...overrides,
  };
}
```

- [ ] **Step 2: Add failing worker-claim tests**

Add:

```typescript
it("claims due non-speak commands for workers and skips speak_to_user", () => {
  const db = createTestDatabase();
  const repo = new ActorCommandRepository(db);
  repo.createMany([
    makeCommand({ commandType: "speak_to_user", idempotencyKey: "cmd:speak" }),
    makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" }),
  ]);

  const claimed = repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 30_000 });

  expect(claimed?.commandType).toBe("move_location");
  expect(claimed?.status).toBe("claimed");
  expect(claimed?.claimedBy).toBe("actor-worker");
  expect(repo.claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 })).toBeNull();
});

it("reclaims worker commands after claim expiry", () => {
  const db = createTestDatabase();
  const repo = new ActorCommandRepository(db);
  const [command] = repo.createMany([makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" })]);
  repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 1 });
  db.sqlite.prepare("UPDATE actor_commands SET claim_expires_at = ? WHERE id = ?").run(Date.now() - 1_000, command.id);

  const reclaimed = repo.claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 });

  expect(reclaimed?.id).toBe(command.id);
  expect(reclaimed?.claimedBy).toBe("actor-worker-2");
});

it("marks claimed commands failed with worker ownership", () => {
  const db = createTestDatabase();
  const repo = new ActorCommandRepository(db);
  const [command] = repo.createMany([makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" })]);
  repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 30_000 });

  const failed = repo.markFailed({ commandId: command.id, claimedBy: "actor-worker", reason: "bad payload" });

  expect(failed?.status).toBe("failed");
  expect(failed?.privateReason).toContain("bad payload");
});
```

- [ ] **Step 3: Run failing repository tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/actor-command-repository.test.ts
```

Expected: fail because worker claim and failure helpers do not exist.

- [ ] **Step 4: Implement repository helpers**

In `ActorCommandRepository`:

- Make `getById` and `getByIdempotencyKey` public.
- Add `claimNextExecutableCommand({ workerId, leaseMs, commandTypes })`.
- Add `markDoneByWorker({ commandId, claimedBy, resultEventId })`.
- Add `markFailed({ commandId, claimedBy, reason })`.

`claimNextExecutableCommand` must only claim:

```typescript
["move_location", "investigate", "remember", "publish_post", "initiate_event"]
```

It must not claim `speak_to_user`, because that path belongs to `WorldInteractionFlow`.

The claim query must select due, non-expired `pending` commands or expired `claimed` commands, order by priority descending then `run_after ASC`, and set `status = 'claimed'`, `claimed_by`, `claimed_at`, and `claim_expires_at`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/actor-command-repository.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/domain/world/actor-command-repository.ts ui/src/server/domain/world/actor-command-repository.test.ts
git commit -m "feat(world): add actor command worker leases"
```

### Task 4: Build WorldMemoryConsolidator

**Files:**
- Create: `ui/src/server/domain/world/world-memory-consolidator.ts`
- Create: `ui/src/server/domain/world/world-memory-consolidator.test.ts`
- Modify: `ui/src/server/domain/world/world-memory-repository.ts`
- Modify: `ui/src/server/domain/world/types.ts`

- [ ] **Step 1: Add memory consolidation result types**

In `ui/src/server/domain/world/types.ts`, add:

```typescript
export type WorldMemoryConsolidationAction = "created" | "superseded" | "appended" | "skipped";

export interface WorldMemoryConsolidationResult {
  action: WorldMemoryConsolidationAction;
  memoryId?: string;
  supersededMemoryId?: string;
  reason: string;
}
```

- [ ] **Step 2: Add repository helper tests**

In `ui/src/server/domain/world/world-memory-repository.test.ts`, add:

```typescript
import type { CreateWorldMemoryInput } from "./types";

function makeWorldMemory(overrides: Partial<CreateWorldMemoryInput> = {}): CreateWorldMemoryInput {
  return {
    userId: "u001",
    worldId: "default",
    subjectType: "world",
    subjectKey: "default",
    memoryType: "rule",
    canonicalKey: "rule:test",
    content: "A world rule.",
    visibility: "public",
    visibleToActorIds: [],
    visibleToUser: true,
    importance: 0.7,
    confidence: 0.8,
    validFromTick: 1,
    sourceEventId: "wevt-source",
    sourceDecisionId: "wdec-source",
    supersededBy: null,
    embeddingJson: null,
    embeddingQuality: null,
    ...overrides,
  };
}

it("finds active memory by canonical key and supersedes it", () => {
  const db = createTestDatabase();
  const repo = new WorldMemoryRepository(db);
  const original = repo.create(makeWorldMemory({ memoryType: "rule", canonicalKey: "rule:weather" }));

  expect(repo.findActiveByCanonicalKey({
    userId: "u001",
    worldId: "default",
    memoryType: "rule",
    canonicalKey: "rule:weather",
  })?.id).toBe(original.id);

  const updated = repo.supersede({ memoryId: original.id, supersededBy: "wmem-next" });

  expect(updated?.supersededBy).toBe("wmem-next");
  expect(repo.findActiveByCanonicalKey({
    userId: "u001",
    worldId: "default",
    memoryType: "rule",
    canonicalKey: "rule:weather",
  })).toBeNull();
});
```

- [ ] **Step 3: Add repository methods**

In `WorldMemoryRepository`, make `getById` public and add:

```typescript
findActiveByCanonicalKey(input: {
  userId: string;
  worldId: string;
  memoryType: string;
  canonicalKey: string;
}): WorldMemoryRecord | null
```

Query active rows where `superseded_by IS NULL`, ordered by `valid_from_tick DESC, created_at DESC`, limited to 1.

Add:

```typescript
supersede(input: { memoryId: string; supersededBy: string }): WorldMemoryRecord | null
```

It updates only rows where `superseded_by IS NULL`.

- [ ] **Step 4: Write consolidator tests**

Create `ui/src/server/domain/world/world-memory-consolidator.test.ts` with three cases:

- `rule` with same `canonicalKey` creates a replacement and supersedes the old row.
- `unresolved_thread` with same `canonicalKey` appends a timeline entry and supersedes the previous row.
- Any candidate derived from world activity with `sourceEventId: null` returns `{ action: "skipped", reason: "source_event_id_required" }`.

Use an injected `embedText` stub:

```typescript
async () => ({
  vector: [1, 0],
  dimension: 2,
  backend: "fallback",
  quality: "lexical",
  model: "test",
  version: 1,
  needsRefresh: true,
})
```

- [ ] **Step 5: Implement consolidator**

Create `ui/src/server/domain/world/world-memory-consolidator.ts`.

Required behavior:

- Accept `{ db, embedText }` in constructor.
- `consolidate({ userId, worldId, sourceDecisionId, currentTick, candidates })` returns `WorldMemoryConsolidationResult[]`.
- Reject world-activity candidates without `sourceEventId`.
- Store embeddings in `embeddingJson` and `embeddingQuality`.
- For no `canonicalKey`, create a new memory.
- For `rule`, `secret`, and `relationship`, replace by canonical key and supersede the old row.
- For `unresolved_thread`, append `- tick ${currentTick}: ${candidate.content}` to the previous content, create a new active row, and supersede the old row.
- For `lore`, supersede only when the candidate has at least the existing confidence and importance; otherwise skip.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-memory-repository.test.ts src/server/domain/world/world-memory-consolidator.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/domain/world/types.ts ui/src/server/domain/world/world-memory-repository.ts ui/src/server/domain/world/world-memory-repository.test.ts ui/src/server/domain/world/world-memory-consolidator.ts ui/src/server/domain/world/world-memory-consolidator.test.ts
git commit -m "feat(world): consolidate world memories"
```

### Task 5: Connect WorldMind Secondary Effects

**Files:**
- Create: `ui/src/server/flow/world-mind-secondary-effects.test.ts`
- Modify: `ui/src/server/flow/world-mind-flow.ts`
- Modify: `ui/src/server/domain/world/types.ts`

- [ ] **Step 1: Add failing secondary effect tests**

Create `ui/src/server/flow/world-mind-secondary-effects.test.ts`.

Test 1: accepted decision with:

- one `world_incident` event with `unresolved: true`,
- one memory candidate,
- one `nextTick`,

must create:

- one committed memory in `world_memories`,
- one idempotent `world_tick` task,
- no duplicate tick task when the same run envelope is retried.

Use memory candidate `sourceEventId: "CLIENT_EVENT:evt-1"` so the secondary effect code must resolve it to the committed event id.

Test 2: accepted `no_op` scheduled tick with no committed events, no unresolved snapshot state, and `nextTick: null` must not enqueue another `world_tick`.

- [ ] **Step 2: Extend `WorldMindContext`**

In `ui/src/server/flow/world-mind-flow.ts`, add:

```typescript
import { TaskRepository } from "@/server/domain/chat/task-repository";
import type { EmbedText } from "@/server/domain/chat/memory-consolidator";
import { WorldMemoryConsolidator } from "@/server/domain/world/world-memory-consolidator";
```

Extend `WorldMindContext`:

```typescript
embedText?: EmbedText;
sourceTaskId?: string | null;
disableSecondaryEffects?: boolean;
```

- [ ] **Step 3: Extend `WorldMindResult`**

Add:

```typescript
proposedEventIdToCommittedEventId?: Record<string, string>;
```

In `commitAcceptedPath`, include:

```typescript
proposedEventIdToCommittedEventId: Object.fromEntries(proposedEventIdToCommittedEventId.entries())
```

- [ ] **Step 4: Add `runWorldMindSecondaryEffects`**

Call it only after `commitAcceptedPath` has returned successfully. Do not call it from rejected, model_failed, or transaction_failed paths.

Required behavior:

- Resolve memory candidate `sourceEventId` values prefixed by `CLIENT_EVENT:` through `proposedEventIdToCommittedEventId`.
- Run `WorldMemoryConsolidator` with accepted memory candidates.
- Load latest snapshot and inspect `state.unresolvedEventIds`.
- Enqueue `world_tick` only when there is an accepted `nextTick`, committed event, or unresolved thread.
- Quiet no-op scheduled ticks must not schedule endless tasks.
- Use idempotency key:

```typescript
`world_tick:${userId}:${worldId}:${worldRunId}:${reason}`
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/world-mind-flow.test.ts src/server/flow/world-mind-secondary-effects.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/flow/world-mind-flow.ts ui/src/server/flow/world-mind-flow.test.ts ui/src/server/flow/world-mind-secondary-effects.test.ts
git commit -m "feat(world): run worldmind secondary effects"
```

### Task 6: Add World Tick Worker

**Files:**
- Create: `ui/src/server/flow/world-tick-worker.ts`
- Create: `ui/src/server/flow/world-tick-worker.test.ts`
- Modify: `ui/src/server/domain/world/world-run-repository.ts`

- [ ] **Step 1: Write failing world tick worker tests**

Create `ui/src/server/flow/world-tick-worker.test.ts`.

Test 1 must:

- enqueue a due `world_tick` task,
- drain one task,
- create a `scheduled_tick` run envelope,
- call injected `createWorldMind`,
- mark the task done.

Test 2 must:

- enqueue an invalid `world_tick` payload,
- drain one task,
- mark it failed and retryable through `TaskRepository.markFailed`.

- [ ] **Step 2: Make idempotency lookup public**

In `WorldRunRepository`, change private `getByIdempotencyKey` to public:

```typescript
getByIdempotencyKey(idempotencyKey: string): WorldRunEnvelope | null
```

- [ ] **Step 3: Implement worker**

Create `ui/src/server/flow/world-tick-worker.ts`.

Required API:

```typescript
export interface DrainWorldTickTasksResult {
  processed: number;
  failed: number;
}

export async function drainWorldTickTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
  createWorldMind?: (ctx: WorldMindContext) => Promise<WorldMindResult>;
}): Promise<DrainWorldTickTasksResult>
```

Required behavior:

- Claim `world_tick` tasks with `workerId` and `leaseMs: 60_000`.
- Validate payload:

```typescript
{
  userId: string;
  worldId: string;
  reason: string;
  scheduledTick: number;
}
```

- Create or get envelope:

```typescript
{
  sourceType: "scheduled_tick",
  sourceActionId: task.id,
  idempotencyKey: `world_tick:${task.idempotencyKey ?? task.id}`,
}
```

- Run `createWorldMindFlow` unless injected.
- Mark task done on success.
- Mark task failed on error.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/world-tick-worker.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/domain/world/world-run-repository.ts ui/src/server/flow/world-tick-worker.ts ui/src/server/flow/world-tick-worker.test.ts
git commit -m "feat(world): add leased world tick worker"
```

### Task 7: Add Actor Command Worker

**Files:**
- Create: `ui/src/server/flow/actor-command-worker.ts`
- Create: `ui/src/server/flow/actor-command-worker.test.ts`
- Modify: `ui/src/server/domain/world/world-reducer.test.ts`

- [ ] **Step 1: Write failing actor command worker tests**

Create `ui/src/server/flow/actor-command-worker.test.ts`.

Test `move_location`:

- seed a `move_location` command,
- drain one command,
- assert a `character_action` event was committed,
- assert reducer moved the character to the target `locationKey`,
- assert the command is `done` with `resultEventId`.

Test `remember`:

- seed a `remember` command with `{ canonicalKey, content }`,
- drain one command,
- assert a `knowledge_reveal` event was committed,
- assert command is `done`.

- [ ] **Step 2: Implement worker**

Create `ui/src/server/flow/actor-command-worker.ts`.

Required API:

```typescript
export interface DrainActorCommandTasksResult {
  processed: number;
  failed: number;
}

export async function drainActorCommandTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
}): Promise<DrainActorCommandTasksResult>
```

Required behavior:

- Claim commands with `ActorCommandRepository.claimNextExecutableCommand`.
- For `publish_post`, call `createFeedGenerateFlow`.
- For `move_location`, validate `payload.locationKey` and commit `character_action`.
- For `investigate`, commit `character_action`.
- For `remember`, commit `knowledge_reveal`.
- For `initiate_event`, commit `world_incident`.
- Commit result event inside a transaction using `WorldEventRepository.createCommitted`.
- Apply reducer and save latest snapshot.
- Upsert reduced character states.
- Mark command done with `resultEventId`.
- Mark command failed if execution throws.
- Use result event idempotency key:

```typescript
`${command.id}:result`
```

- [ ] **Step 3: Add reducer coverage for command result events**

In `ui/src/server/domain/world/world-reducer.test.ts`, add:

```typescript
it("moves a character from a command result character_action event", () => {
  const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default" });
  const result = reduceWorldEvents({
    previousSnapshot,
    reducerVersion: 1,
    previousCharacterStates: [makeCharacterState({ agentId: "agent-default", locationKey: "start" })],
    events: [
      event({
        id: "wevt-move",
        sequence: 1,
        type: "character_action",
        actorIds: ["agent-default"],
        payload: { action: "move_location", locationKey: "harbor", summary: "Move to the harbor." },
        summary: "Move to the harbor.",
      }),
    ],
  });
  expect(result.characterStates?.[0].locationKey).toBe("harbor");
});

it("adds knowledge keys from a command result knowledge_reveal event", () => {
  const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default" });
  const result = reduceWorldEvents({
    previousSnapshot,
    reducerVersion: 1,
    previousCharacterStates: [makeCharacterState({ agentId: "agent-default", locationKey: "start" })],
    events: [
      event({
        id: "wevt-remember",
        sequence: 1,
        type: "knowledge_reveal",
        actorIds: ["agent-default"],
        payload: { factKey: "secret:harbor-password", summary: "The harbor password clue is a silver bell." },
        summary: "The harbor password clue is a silver bell.",
      }),
    ],
  });
  expect(result.characterStates?.[0].knowledgeKeys).toContain("secret:harbor-password");
});
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/actor-command-repository.test.ts src/server/domain/world/world-reducer.test.ts src/server/flow/actor-command-worker.test.ts
```

Expected: pass.

Commit:

```bash
git add ui/src/server/flow/actor-command-worker.ts ui/src/server/flow/actor-command-worker.test.ts ui/src/server/domain/world/world-reducer.test.ts
git commit -m "feat(world): execute actor commands through events"
```

### Task 8: Add End-To-End World Loop Verification

**Files:**
- Create: `ui/src/server/flow/world-loop-integration.test.ts`
- Modify: `ui/src/server/flow/world-mind-flow.test.ts`
- Modify: `ui/src/server/flow/world-interaction-flow.test.ts`

- [ ] **Step 1: Write integration test**

Create `ui/src/server/flow/world-loop-integration.test.ts`.

The test must verify this full loop:

1. A user-action `WorldMindFlow` run commits `user_action` and `world_incident`.
2. The accepted decision persists a non-chat actor command.
3. The accepted decision schedules one `world_tick` task.
4. `drainWorldTickTasks` claims and completes that tick idempotently.
5. `drainActorCommandTasks` executes the command through a result event.
6. Final committed event order by `sequence` is:

```typescript
["user_action", "world_incident", "character_action"]
```

7. All event idempotency keys are unique.
8. No second executable actor command remains.

- [ ] **Step 2: Run the failing integration test**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/world-loop-integration.test.ts
```

Expected: fail until all Phase 4 worker pieces are complete.

- [ ] **Step 3: Fix strict gaps revealed by integration**

Apply these scoped fixes:

- Event ordering must use `sequence`, not `created_at`.
- Tick retry must reuse the task idempotency key when creating `world_runs`.
- Command retry must reuse `${command.id}:result`.
- Quiet worlds must require accepted `nextTick`, committed events, or unresolved snapshot state before scheduling another tick.

- [ ] **Step 4: Run full Phase 4 verification**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase4.test.ts src/server/domain/chat/task-repository.test.ts src/server/domain/chat/task-repository-lease.test.ts src/server/domain/world/actor-command-repository.test.ts src/server/domain/world/world-memory-repository.test.ts src/server/domain/world/world-memory-consolidator.test.ts src/server/domain/world/world-reducer.test.ts src/server/flow/world-mind-flow.test.ts src/server/flow/world-mind-secondary-effects.test.ts src/server/flow/world-tick-worker.test.ts src/server/flow/actor-command-worker.test.ts src/server/flow/world-loop-integration.test.ts
```

Expected: pass.

- [ ] **Step 5: Run lint and build**

Run:

```bash
cd ui && npm run lint && npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/flow/world-loop-integration.test.ts ui/src/server/flow/world-mind-flow.test.ts ui/src/server/flow/world-interaction-flow.test.ts
git commit -m "test(world): verify long-running world loop"
```

---

## Self-Review Against Spec

- Source of truth remains `world_events`. Workers create result events before reducer state changes.
- WorldMind still proposes only; validators and transactions still decide accepted world changes.
- Memory consolidation runs after accepted commits and cannot invalidate world state.
- Next tick scheduling runs after accepted commits and uses task idempotency.
- Quiet no-op scheduled ticks do not schedule endless future work.
- `TaskRepository.claimNext` is lease-based and retryable, not select-then-update without lock metadata.
- Command execution is separate from command persistence. `speak_to_user` remains handled by `WorldInteractionFlow`; other command types are handled by `ActorCommandWorker`.
- Hidden facts and `privateReason` are not injected into chat prompts by this phase.

## Execution Notes

Run tasks in order. Task 1 and Task 2 are prerequisites for all worker behavior. Task 5 depends on Task 4. Task 6 and Task 7 can run in parallel after Task 2 and Task 3, but integration verification in Task 8 must run last.

---

## Detailed Implementation Appendix

The task list above is the execution order. This appendix restores the full code-level detail for the steps that are easiest to get wrong during implementation.

### Appendix A: TaskRepository Implementation Details

Use this complete `enqueue` body in `ui/src/server/domain/chat/task-repository.ts`:

```typescript
  enqueue(input: {
    kind: string;
    payload: unknown;
    runAfter?: number;
    idempotencyKey?: string | null;
    maxAttempts?: number;
  }): TaskRecord {
    if (input.idempotencyKey) {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const now = Date.now();
    const id = `task-${randomUUID()}`;
    const runAfter = input.runAfter ?? now;
    const nextAttemptAt = runAfter;

    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO tasks
            (id, kind, payload_json, status, attempts, last_error, run_after, idempotency_key,
             max_attempts, next_attempt_at, created_at, updated_at)
           VALUES
            (?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          JSON.stringify(input.payload ?? {}),
          runAfter,
          input.idempotencyKey ?? null,
          input.maxAttempts ?? 3,
          nextAttemptAt,
          now,
          now,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const retry = this.getByIdempotencyKey(input.idempotencyKey);
        if (retry) {
          return retry;
        }
      }
      throw error;
    }

    return this.get(id) as TaskRecord;
  }
```

Use this complete `claimNext` body:

```typescript
  claimNext(opts?: { kinds?: string[]; workerId?: string; leaseMs?: number }): TaskRecord | null {
    const now = Date.now();
    const workerId = opts?.workerId ?? `worker-${process.pid}`;
    const leaseMs = opts?.leaseMs ?? 60_000;
    const lockExpiresAt = now + leaseMs;
    const kinds = opts?.kinds && opts.kinds.length > 0 ? opts.kinds : null;

    return this.db.sqlite.transaction(() => {
      const kindClause = kinds ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const params = kinds ? [now, now, now, ...kinds] : [now, now, now];
      const row = this.db.sqlite
        .prepare(
          `SELECT id FROM tasks
           WHERE status IN ('pending', 'running')
             AND run_after <= ?
             AND COALESCE(next_attempt_at, run_after) <= ?
             AND failed_permanently_at IS NULL
             AND (
               status = 'pending'
               OR (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
             )
             ${kindClause}
           ORDER BY COALESCE(next_attempt_at, run_after) ASC, created_at ASC
           LIMIT 1`,
        )
        .get(...params) as { id: string } | undefined;
      if (!row) {
        return null;
      }

      const result = this.db.sqlite
        .prepare(
          `UPDATE tasks
           SET status = 'running',
               locked_by = ?,
               locked_at = ?,
               lock_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND failed_permanently_at IS NULL
             AND (
               status = 'pending'
               OR (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
             )`,
        )
        .run(workerId, now, lockExpiresAt, now, row.id, now);

      if (result.changes === 0) {
        return null;
      }
      return this.get(row.id);
    })();
  }
```

Use these complete completion helpers:

```typescript
  markDone(id: string): TaskRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE tasks
         SET status = 'done',
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
    return result.changes === 0 ? null : this.get(id);
  }

  markFailed(id: string, error: string): TaskRecord | null {
    const now = Date.now();
    const current = this.get(id);
    if (!current) {
      return null;
    }

    const nextAttempts = current.attempts + 1;
    const permanent = nextAttempts >= current.maxAttempts;
    const backoffMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, nextAttempts - 1));
    const result = this.db.sqlite
      .prepare(
        `UPDATE tasks
         SET status = ?,
             attempts = ?,
             last_error = ?,
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL,
             next_attempt_at = ?,
             failed_permanently_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        permanent ? "failed" : "pending",
        nextAttempts,
        error,
        permanent ? null : now + backoffMs,
        permanent ? now : null,
        now,
        id,
      );
    return result.changes === 0 ? null : this.get(id);
  }

  getByIdempotencyKey(idempotencyKey: string): TaskRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM tasks WHERE idempotency_key = ?")
      .get(idempotencyKey) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
```

Update `mapTask` with:

```typescript
function mapTask(row: TaskRow): TaskRecord {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    runAfter: row.run_after,
    idempotencyKey: row.idempotency_key,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
    failedPermanentlyAt: row.failed_permanently_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

### Appendix B: Actor Command Repository Helper Details

Use this implementation for `claimNextExecutableCommand`:

```typescript
  claimNextExecutableCommand(input: {
    workerId: string;
    leaseMs: number;
    commandTypes?: ActorCommandType[];
  }): ActorCommandRecord | null {
    const now = Date.now();
    const claimExpiresAt = now + input.leaseMs;
    const commandTypes = input.commandTypes ?? ["move_location", "investigate", "remember", "publish_post", "initiate_event"];

    return this.db.sqlite.transaction(() => {
      const row = this.db.sqlite
        .prepare(
          `SELECT * FROM actor_commands
           WHERE command_type IN (${commandTypes.map(() => "?").join(", ")})
             AND run_after <= ?
             AND (expires_at IS NULL OR expires_at > ?)
             AND (
               status = 'pending'
               OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
             )
           ORDER BY
             (CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END) DESC,
             run_after ASC,
             created_at ASC
           LIMIT 1`,
        )
        .get(...commandTypes, now, now, now) as ActorCommandRow | undefined;
      if (!row) {
        return null;
      }

      const result = this.db.sqlite
        .prepare(
          `UPDATE actor_commands
           SET status = 'claimed',
               claimed_by = ?,
               claimed_at = ?,
               claim_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND (
               status = 'pending'
               OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
             )`,
        )
        .run(input.workerId, now, claimExpiresAt, now, row.id, now);

      return result.changes === 0 ? null : this.getById(row.id);
    })();
  }
```

Use these completion helpers:

```typescript
  markDoneByWorker(input: {
    commandId: string;
    claimedBy: string;
    resultEventId?: string | null;
  }): ActorCommandRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'done',
             result_event_id = ?,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by = ?`,
      )
      .run(input.resultEventId ?? null, now, input.commandId, input.claimedBy);
    return result.changes === 0 ? null : this.getById(input.commandId);
  }

  markFailed(input: { commandId: string; claimedBy: string; reason: string }): ActorCommandRecord | null {
    const now = Date.now();
    const current = this.getById(input.commandId);
    const nextPrivateReason = [current?.privateReason, `failure: ${input.reason}`].filter(Boolean).join("\n");
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'failed',
             private_reason = ?,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by = ?`,
      )
      .run(nextPrivateReason, now, input.commandId, input.claimedBy);
    return result.changes === 0 ? null : this.getById(input.commandId);
  }
```

The command repository test helper must be present:

```typescript
function makeCommand(overrides: Partial<CreateActorCommandInput> = {}): CreateActorCommandInput {
  const now = Date.now();
  return {
    decisionId: "wdec-test",
    worldRunId: "wrun-test",
    userId: "u001",
    worldId: "default",
    targetAgentId: "agent-default",
    commandType: "move_location",
    priority: "normal",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    actorInstruction: "Move to the square.",
    privateReason: null,
    cause: { type: "director_no_event", reasonCode: "test" },
    payload: { locationKey: "square" },
    relatedEventId: null,
    runAfter: now,
    expiresAt: null,
    idempotencyKey: "cmd:test",
    ...overrides,
  };
}
```

### Appendix C: WorldMemoryConsolidator Full Test File

Create `ui/src/server/domain/world/world-memory-consolidator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import type { WorldMemoryCandidate } from "./world-decision";
import { WorldMemoryRepository } from "./world-memory-repository";
import { WorldMemoryConsolidator } from "./world-memory-consolidator";

function candidate(overrides: Partial<WorldMemoryCandidate> = {}): WorldMemoryCandidate {
  return {
    subjectType: "world",
    subjectKey: "default",
    memoryType: "rule",
    canonicalKey: "rule:weather",
    content: "Rain makes the old city gates open late.",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    importance: 0.8,
    confidence: 0.9,
    sourceEventId: "wevt-source",
    ...overrides,
  };
}

const embedTextStub = async () => ({
  vector: [1, 0],
  dimension: 2,
  backend: "fallback" as const,
  quality: "lexical" as const,
  model: "test",
  version: 1,
  needsRefresh: true,
});

describe("WorldMemoryConsolidator", () => {
  it("supersedes rule memories with the same canonical key", async () => {
    const db = createTestDatabase();
    const repo = new WorldMemoryRepository(db);
    const existing = repo.create({
      userId: "u001",
      worldId: "default",
      subjectType: "world",
      subjectKey: "default",
      memoryType: "rule",
      canonicalKey: "rule:weather",
      content: "Rain closes the old city gates.",
      visibility: "public",
      visibleToActorIds: [],
      visibleToUser: true,
      importance: 0.6,
      confidence: 0.7,
      validFromTick: 1,
      sourceEventId: "wevt-old",
      sourceDecisionId: "wdec-old",
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    const result = await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 2,
      candidates: [candidate({ content: "Rain makes the old city gates open late." })],
    });

    expect(result).toEqual([expect.objectContaining({ action: "superseded", supersededMemoryId: existing.id })]);
    const active = repo.findActiveByCanonicalKey({
      userId: "u001",
      worldId: "default",
      memoryType: "rule",
      canonicalKey: "rule:weather",
    });
    expect(active?.content).toBe("Rain makes the old city gates open late.");
    expect(repo.getById(existing.id)?.supersededBy).toBe(active?.id);
  });

  it("appends unresolved_thread memories by canonical key", async () => {
    const db = createTestDatabase();
    const repo = new WorldMemoryRepository(db);
    repo.create({
      userId: "u001",
      worldId: "default",
      subjectType: "world",
      subjectKey: "default",
      memoryType: "unresolved_thread",
      canonicalKey: "thread:gate",
      content: "- tick 1: The gate lock was missing.",
      visibility: "hidden",
      visibleToActorIds: [],
      visibleToUser: false,
      importance: 0.7,
      confidence: 0.8,
      validFromTick: 1,
      sourceEventId: "wevt-old",
      sourceDecisionId: "wdec-old",
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 3,
      candidates: [
        candidate({
          memoryType: "unresolved_thread",
          canonicalKey: "thread:gate",
          content: "The captain asked who last held the key.",
          visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
        }),
      ],
    });

    const active = repo.findActiveByCanonicalKey({
      userId: "u001",
      worldId: "default",
      memoryType: "unresolved_thread",
      canonicalKey: "thread:gate",
    });
    expect(active?.content).toContain("tick 1");
    expect(active?.content).toContain("tick 3");
  });

  it("skips candidates derived from world activity without source event id", async () => {
    const db = createTestDatabase();
    const result = await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 3,
      candidates: [candidate({ sourceEventId: null })],
    });

    expect(result[0]).toEqual(expect.objectContaining({ action: "skipped", reason: "source_event_id_required" }));
  });
});
```

### Appendix D: WorldMemoryConsolidator Full Implementation

Create `ui/src/server/domain/world/world-memory-consolidator.ts`:

```typescript
import { embedText as defaultEmbedText } from "@/server/ai/embeddings";
import type { EmbedText } from "@/server/domain/chat/memory-consolidator";
import type { AppDatabase } from "@/server/db/client";
import type { WorldMemoryCandidate } from "./world-decision";
import type { WorldMemoryConsolidationResult, WorldMemoryVisibility } from "./types";
import { WorldMemoryRepository } from "./world-memory-repository";

export class WorldMemoryConsolidator {
  private readonly memories: WorldMemoryRepository;
  private readonly embedText: EmbedText;

  constructor(input: { db: AppDatabase; embedText?: EmbedText }) {
    this.memories = new WorldMemoryRepository(input.db);
    this.embedText = input.embedText ?? defaultEmbedText;
  }

  async consolidate(input: {
    userId: string;
    worldId: string;
    sourceDecisionId: string;
    currentTick: number;
    candidates: WorldMemoryCandidate[];
  }): Promise<WorldMemoryConsolidationResult[]> {
    const results: WorldMemoryConsolidationResult[] = [];
    for (const candidate of input.candidates) {
      results.push(await this.consolidateOne({ ...input, candidate }));
    }
    return results;
  }

  private async consolidateOne(input: {
    userId: string;
    worldId: string;
    sourceDecisionId: string;
    currentTick: number;
    candidate: WorldMemoryCandidate;
  }): Promise<WorldMemoryConsolidationResult> {
    const { candidate } = input;
    if (candidate.sourceEventId == null) {
      return { action: "skipped", reason: "source_event_id_required" };
    }

    const embedding = await this.embedText(candidate.content);
    const createInput = {
      userId: input.userId,
      worldId: input.worldId,
      subjectType: candidate.subjectType,
      subjectKey: candidate.subjectKey,
      memoryType: candidate.memoryType,
      canonicalKey: candidate.canonicalKey,
      content: candidate.content,
      visibility: candidate.visibility.mode as WorldMemoryVisibility,
      visibleToActorIds: candidate.visibility.visibleToActorIds,
      visibleToUser: candidate.visibility.visibleToUser,
      importance: candidate.importance,
      confidence: candidate.confidence,
      validFromTick: input.currentTick,
      sourceEventId: candidate.sourceEventId,
      sourceDecisionId: input.sourceDecisionId,
      supersededBy: null,
      embeddingJson: JSON.stringify(embedding.vector),
      embeddingQuality: embedding.quality,
    };

    if (!candidate.canonicalKey) {
      const created = this.memories.create(createInput);
      return { action: "created", memoryId: created.id, reason: "no_canonical_key" };
    }

    const existing = this.memories.findActiveByCanonicalKey({
      userId: input.userId,
      worldId: input.worldId,
      memoryType: candidate.memoryType,
      canonicalKey: candidate.canonicalKey,
    });

    if (!existing) {
      const created = this.memories.create(createInput);
      return { action: "created", memoryId: created.id, reason: "new_canonical_key" };
    }

    if (candidate.memoryType === "unresolved_thread") {
      const created = this.memories.create({
        ...createInput,
        content: `${existing.content}\n- tick ${input.currentTick}: ${candidate.content}`,
      });
      this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
      return { action: "appended", memoryId: created.id, supersededMemoryId: existing.id, reason: "thread_timeline_appended" };
    }

    if (candidate.memoryType === "rule" || candidate.memoryType === "secret" || candidate.memoryType === "relationship") {
      const created = this.memories.create(createInput);
      this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
      return { action: "superseded", memoryId: created.id, supersededMemoryId: existing.id, reason: `${candidate.memoryType}_canonical_replacement` };
    }

    if (candidate.memoryType === "lore") {
      if (candidate.confidence >= existing.confidence && candidate.importance >= existing.importance) {
        const created = this.memories.create(createInput);
        this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
        return { action: "superseded", memoryId: created.id, supersededMemoryId: existing.id, reason: "lore_higher_quality" };
      }
      return { action: "skipped", memoryId: existing.id, reason: "lore_existing_quality_wins" };
    }

    return { action: "skipped", memoryId: existing.id, reason: "unknown_memory_type" };
  }
}
```

### Appendix E: WorldMind Secondary Effects Test

Create `ui/src/server/flow/world-mind-secondary-effects.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { WorldMemoryRepository } from "@/server/domain/world/world-memory-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import type { WorldMindDecision } from "@/server/domain/world/world-decision";
import { createWorldMindFlow } from "./world-mind-flow";

function decisionWithMemoryAndTick(): WorldMindDecision {
  return {
    observations: ["A thread remains unresolved."],
    intent: "trigger_event",
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: [],
        payload: {
          title: "A lock goes missing",
          description: "The gate lock is missing.",
          unresolved: true,
          factKey: "gate-lock-missing",
        },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "The gate lock is missing.",
      },
    ],
    commands: [],
    memories: [
      {
        subjectType: "world",
        subjectKey: "default",
        memoryType: "unresolved_thread",
        canonicalKey: "thread:gate-lock",
        content: "The missing lock needs follow-up.",
        visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
        importance: 0.8,
        confidence: 0.9,
        sourceEventId: "CLIENT_EVENT:evt-1",
      },
    ],
    nextTick: { delayMs: 60_000, reason: "follow up on missing lock" },
  };
}

describe("WorldMind secondary effects", () => {
  it("consolidates memory candidates and schedules one idempotent next tick after accepted commit", async () => {
    const db = createTestDatabase();
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const envelope = new WorldRunRepository(db).createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-1",
    });
    const decision = decisionWithMemoryAndTick();

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "inspect the gate", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
      embedText: async () => ({
        vector: [1, 0],
        dimension: 2,
        backend: "fallback",
        quality: "lexical",
        model: "test",
        version: 1,
        needsRefresh: true,
      }),
    });

    expect(new WorldMemoryRepository(db).recallForDirector({ userId: "u001", worldId: "default", subjectType: "world" })).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM tasks WHERE kind = 'world_tick'").all()).toHaveLength(1);

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "inspect the gate", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
    }).catch(() => null);

    expect(db.sqlite.prepare("SELECT * FROM tasks WHERE kind = 'world_tick'").all()).toHaveLength(1);
  });

  it("does not schedule endless ticks for accepted no-op decisions without unresolved state", async () => {
    const db = createTestDatabase();
    const enqueueSpy = vi.spyOn(TaskRepository.prototype, "enqueue");
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const envelope = new WorldRunRepository(db).createOrGet({
      userId: "u001",
      worldId: "default",
      sourceType: "scheduled_tick",
      sourceActionId: "task-1",
      idempotencyKey: "worldtick:task-1",
    });

    await createWorldMindFlow({
      db,
      envelope,
      generateDecision: async () => ({
        decision: { observations: [], intent: "no_op", events: [], commands: [], memories: [], nextTick: null },
        rawDecisionJson: "{}",
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    expect(enqueueSpy).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "world_tick" }));
  });
});
```

### Appendix F: WorldMind Secondary Effects Implementation

Add this helper to `ui/src/server/flow/world-mind-flow.ts`:

```typescript
async function runWorldMindSecondaryEffects(input: {
  db: AppDatabase;
  envelope: WorldRunEnvelope;
  decision: WorldMindDecision;
  result: WorldMindResult;
  embedText?: EmbedText;
  disabled: boolean;
}): Promise<void> {
  if (input.disabled || input.result.validationStatus !== "accepted") {
    return;
  }

  const latestSnapshot = new WorldStateRepository(input.db).getLatest({
    userId: input.envelope.userId,
    worldId: input.envelope.worldId,
  });
  const currentTick = latestSnapshot?.tick ?? 0;
  const eventMap = input.result.proposedEventIdToCommittedEventId ?? {};
  const candidates = input.decision.memories.map((candidate) => ({
    ...candidate,
    sourceEventId:
      candidate.sourceEventId?.startsWith("CLIENT_EVENT:")
        ? eventMap[candidate.sourceEventId.slice("CLIENT_EVENT:".length)] ?? null
        : candidate.sourceEventId,
  }));

  if (candidates.length > 0) {
    await new WorldMemoryConsolidator({ db: input.db, embedText: input.embedText }).consolidate({
      userId: input.envelope.userId,
      worldId: input.envelope.worldId,
      sourceDecisionId: input.envelope.decisionId,
      currentTick,
      candidates,
    });
  }

  const hasCommittedEvent = input.result.createdEventIds.length > 0;
  const hasUnresolvedThread = (latestSnapshot?.state.unresolvedEventIds.length ?? 0) > 0;
  if (!hasCommittedEvent && !hasUnresolvedThread && !input.decision.nextTick) {
    return;
  }
  if (!input.decision.nextTick && !hasUnresolvedThread) {
    return;
  }

  const delayMs = input.decision.nextTick?.delayMs ?? 10 * 60_000;
  const reason = input.decision.nextTick?.reason ?? "unresolved world thread";
  const scheduledTick = Date.now() + delayMs;
  new TaskRepository(input.db).enqueue({
    kind: "world_tick",
    payload: {
      userId: input.envelope.userId,
      worldId: input.envelope.worldId,
      reason,
      scheduledTick,
    },
    runAfter: scheduledTick,
    idempotencyKey: `world_tick:${input.envelope.userId}:${input.envelope.worldId}:${input.envelope.worldRunId}:${reason}`,
  });
}
```

Call it from the accepted path:

```typescript
  const result = await commitAcceptedPath({
    db,
    envelope,
    decision,
    dirContext,
    ctx,
    characterStates,
    modelProvider,
    modelName,
    rawDecisionJson,
  });
  await runWorldMindSecondaryEffects({
    db,
    envelope,
    decision,
    result,
    embedText: ctx.embedText,
    disabled: ctx.disableSecondaryEffects === true,
  });
  return result;
```

### Appendix G: World Tick Worker Full Test File

Create `ui/src/server/flow/world-tick-worker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { drainWorldTickTasks } from "./world-tick-worker";

describe("drainWorldTickTasks", () => {
  it("claims a world_tick task, creates a scheduled_tick envelope, runs WorldMind, and marks the task done", async () => {
    const db = createTestDatabase();
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({
      kind: "world_tick",
      payload: { userId: "u001", worldId: "default", reason: "test tick", scheduledTick: Date.now() },
      idempotencyKey: "tick:u001:default:1",
    });

    const result = await drainWorldTickTasks({
      db,
      limit: 1,
      workerId: "tick-worker",
      createWorldMind: async () => ({
        validationStatus: "accepted",
        decisionLogId: "log-1",
        createdEventIds: [],
        createdCommandIds: [],
        proposedEventIdToCommittedEventId: {},
      }),
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(tasks.get(task.id)?.status).toBe("done");
    const run = new WorldRunRepository(db).getByIdempotencyKey("world_tick:tick:u001:default:1");
    expect(run?.sourceType).toBe("scheduled_tick");
    expect(run?.sourceActionId).toBe(task.id);
  });

  it("marks invalid tick payloads failed and retryable", async () => {
    const db = createTestDatabase();
    const task = new TaskRepository(db).enqueue({ kind: "world_tick", payload: { userId: "u001" }, maxAttempts: 2 });

    const result = await drainWorldTickTasks({ db, limit: 1, workerId: "tick-worker" });

    expect(result.failed).toBe(1);
    expect(new TaskRepository(db).get(task.id)?.status).toBe("pending");
  });
});
```

### Appendix H: World Tick Worker Full Implementation

Create `ui/src/server/flow/world-tick-worker.ts`:

```typescript
import type { AppDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import type { WorldMindContext, WorldMindResult } from "./world-mind-flow";
import { createWorldMindFlow } from "./world-mind-flow";

export interface DrainWorldTickTasksResult {
  processed: number;
  failed: number;
}

export async function drainWorldTickTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
  createWorldMind?: (ctx: WorldMindContext) => Promise<WorldMindResult>;
}): Promise<DrainWorldTickTasksResult> {
  const tasks = new TaskRepository(options.db);
  const limit = Math.max(0, options.limit ?? 3);
  const workerId = options.workerId ?? "world-tick-worker";
  const runWorldMind = options.createWorldMind ?? createWorldMindFlow;
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const task = tasks.claimNext({ kinds: ["world_tick"], workerId, leaseMs: 60_000 });
    if (!task) {
      break;
    }

    try {
      const payload = parseWorldTickPayload(task.payload);
      const envelope = new WorldRunRepository(options.db).createOrGet({
        userId: payload.userId,
        worldId: payload.worldId,
        sourceType: "scheduled_tick",
        sourceActionId: task.id,
        idempotencyKey: `world_tick:${task.idempotencyKey ?? task.id}`,
      });
      await runWorldMind({
        db: options.db,
        envelope,
        sourceTaskId: task.id,
        sourceInput: { message: payload.reason, targetAgentId: "" },
      });
      tasks.markDone(task.id);
      processed += 1;
    } catch (error) {
      tasks.markFailed(task.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }

  return { processed, failed };
}

function parseWorldTickPayload(payload: unknown): {
  userId: string;
  worldId: string;
  reason: string;
  scheduledTick: number;
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid world_tick payload");
  }
  const record = payload as Record<string, unknown>;
  return {
    userId: readRequiredString(record, "userId"),
    worldId: readRequiredString(record, "worldId"),
    reason: readRequiredString(record, "reason"),
    scheduledTick: readRequiredNumber(record, "scheduledTick"),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid world_tick payload: ${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid world_tick payload: ${key}`);
  }
  return value;
}
```

### Appendix I: Actor Command Worker Full Test File

Create `ui/src/server/flow/actor-command-worker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository } from "@/server/domain/world/character-state-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { drainActorCommandTasks } from "./actor-command-worker";

function seedMoveCommand(db: ReturnType<typeof createTestDatabase>) {
  const [command] = new ActorCommandRepository(db).createMany([
    {
      decisionId: "wdec-1",
      worldRunId: "wrun-1",
      userId: "u001",
      worldId: "default",
      targetAgentId: "agent-default",
      commandType: "move_location",
      priority: "normal",
      visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
      actorInstruction: "Move to the harbor.",
      privateReason: "The harbor thread is active.",
      cause: { type: "director_no_event", reasonCode: "test" },
      payload: { locationKey: "harbor" },
      relatedEventId: null,
      runAfter: Date.now(),
      expiresAt: null,
      idempotencyKey: "cmd:move:1",
    },
  ]);
  return command;
}

describe("drainActorCommandTasks", () => {
  it("executes move_location by committing a character_action event before reducer state changes", async () => {
    const db = createTestDatabase();
    new CharacterStateRepository(db).getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });
    const command = seedMoveCommand(db);

    const result = await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    expect(result).toEqual({ processed: 1, failed: 0 });
    const events = new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" });
    expect(events.map((event) => event.type)).toContain("character_action");
    expect(new CharacterStateRepository(db).listForWorld({ userId: "u001", worldId: "default" })[0].locationKey).toBe("harbor");
    expect(new ActorCommandRepository(db).getById(command.id)?.status).toBe("done");
    expect(new ActorCommandRepository(db).getById(command.id)?.resultEventId).toBeTruthy();
  });

  it("executes remember by creating a knowledge_reveal result event", async () => {
    const db = createTestDatabase();
    new ActorCommandRepository(db).createMany([
      {
        decisionId: "wdec-1",
        worldRunId: "wrun-1",
        userId: "u001",
        worldId: "default",
        targetAgentId: "agent-default",
        commandType: "remember",
        priority: "normal",
        visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
        actorInstruction: "Remember the harbor password clue.",
        privateReason: null,
        cause: { type: "director_no_event", reasonCode: "test" },
        payload: { canonicalKey: "secret:harbor-password", content: "The harbor password clue is a silver bell." },
        relatedEventId: null,
        runAfter: Date.now(),
        expiresAt: null,
        idempotencyKey: "cmd:remember:1",
      },
    ]);

    const result = await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    expect(result.processed).toBe(1);
    expect(new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" }).some((event) => event.type === "knowledge_reveal")).toBe(true);
  });
});
```

### Appendix J: Actor Command Worker Full Implementation

Create `ui/src/server/flow/actor-command-worker.ts`:

```typescript
import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import { createFeedGenerateFlow } from "./feed-flow";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository } from "@/server/domain/world/character-state-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldStateRepository, createInitialWorldSnapshot } from "@/server/domain/world/world-state-repository";
import { reduceWorldEvents } from "@/server/domain/world/world-reducer";
import type { ActorCommandRecord, WorldEventRecord } from "@/server/domain/world/types";

export interface DrainActorCommandTasksResult {
  processed: number;
  failed: number;
}

export async function drainActorCommandTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
}): Promise<DrainActorCommandTasksResult> {
  const commands = new ActorCommandRepository(options.db);
  const workerId = options.workerId ?? "actor-command-worker";
  const limit = Math.max(0, options.limit ?? 3);
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const command = commands.claimNextExecutableCommand({ workerId, leaseMs: 60_000 });
    if (!command) {
      break;
    }

    try {
      const resultEvent = await executeActorCommand({ db: options.db, command });
      commands.markDoneByWorker({ commandId: command.id, claimedBy: workerId, resultEventId: resultEvent?.id ?? null });
      processed += 1;
    } catch (error) {
      commands.markFailed({ commandId: command.id, claimedBy: workerId, reason: error instanceof Error ? error.message : String(error) });
      failed += 1;
    }
  }

  return { processed, failed };
}

async function executeActorCommand(input: {
  db: AppDatabase;
  command: ActorCommandRecord;
}): Promise<WorldEventRecord | null> {
  if (input.command.commandType === "publish_post") {
    await createFeedGenerateFlow({ db: input.db }).run({
      userId: input.command.userId,
      agentId: input.command.targetAgentId,
      worldId: input.command.worldId,
      sourceTaskId: input.command.id,
    });
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "publish_post", summary: input.command.actorInstruction },
      summary: "Actor published a feed post.",
    });
  }

  if (input.command.commandType === "move_location") {
    const payload = input.command.payload as { locationKey?: unknown };
    if (typeof payload.locationKey !== "string" || payload.locationKey.length === 0) {
      throw new Error("move_location payload requires locationKey");
    }
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "move_location", locationKey: payload.locationKey, summary: input.command.actorInstruction },
      summary: input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "investigate") {
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "investigate", summary: input.command.actorInstruction },
      summary: input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "remember") {
    const payload = input.command.payload as { canonicalKey?: unknown; content?: unknown };
    const factKey = typeof payload.canonicalKey === "string" && payload.canonicalKey.length > 0 ? payload.canonicalKey : `memory:${input.command.id}`;
    return commitCommandResultEvent(input, {
      type: "knowledge_reveal",
      payload: { factKey, summary: typeof payload.content === "string" ? payload.content : input.command.actorInstruction },
      summary: typeof payload.content === "string" ? payload.content : input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "initiate_event") {
    return commitCommandResultEvent(input, {
      type: "world_incident",
      payload: { title: "Actor initiated event", description: input.command.actorInstruction, unresolved: true },
      summary: input.command.actorInstruction,
    });
  }

  throw new Error(`Unsupported actor command type: ${input.command.commandType}`);
}

function commitCommandResultEvent(input: {
  db: AppDatabase;
  command: ActorCommandRecord;
}, eventInput: {
  type: Exclude<WorldEventRecord["type"], "user_action">;
  payload: unknown;
  summary: string;
}): WorldEventRecord {
  const eventRepo = new WorldEventRepository(input.db);
  const snapshotRepo = new WorldStateRepository(input.db);
  const charRepo = new CharacterStateRepository(input.db);

  return input.db.sqlite.transaction(() => {
    const sequence = eventRepo.allocateNextSequence({
      userId: input.command.userId,
      worldId: input.command.worldId,
    });
    const event = eventRepo.createCommitted({
      decisionId: input.command.decisionId,
      worldRunId: input.command.worldRunId,
      userId: input.command.userId,
      worldId: input.command.worldId,
      tick: 1,
      sequence,
      type: eventInput.type,
      payload: eventInput.payload,
      summary: eventInput.summary,
      visibility: input.command.visibility,
      actorIds: [input.command.targetAgentId],
      causedByEventId: input.command.relatedEventId,
      idempotencyKey: `${input.command.id}:result`,
    });

    const previousSnapshot =
      snapshotRepo.getLatest({ userId: input.command.userId, worldId: input.command.worldId }) ??
      createInitialWorldSnapshot({ userId: input.command.userId, worldId: input.command.worldId });
    const characterStates = charRepo.listForWorld({ userId: input.command.userId, worldId: input.command.worldId });
    const reducerResult = reduceWorldEvents({
      previousSnapshot,
      events: [event],
      reducerVersion: 1,
      previousCharacterStates: characterStates,
    });

    snapshotRepo.saveLatest({
      ...reducerResult.worldSnapshot,
      id: `wsnap-${randomUUID()}`,
      appliedEventIds: reducerResult.appliedEventIds,
      reducerVersion: 1,
      updatedAt: Date.now(),
    });
    if (reducerResult.characterStates && reducerResult.characterStates.length > 0) {
      charRepo.upsertMany(reducerResult.characterStates);
    }
    return event;
  })();
}
```

### Appendix K: Reducer Command Result Tests

Add these tests to `ui/src/server/domain/world/world-reducer.test.ts`:

```typescript
it("moves a character from a command result character_action event", () => {
  const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default" });
  const result = reduceWorldEvents({
    previousSnapshot,
    reducerVersion: 1,
    previousCharacterStates: [makeCharacterState({ agentId: "agent-default", locationKey: "start" })],
    events: [
      event({
        id: "wevt-move",
        sequence: 1,
        type: "character_action",
        actorIds: ["agent-default"],
        payload: { action: "move_location", locationKey: "harbor", summary: "Move to the harbor." },
        summary: "Move to the harbor.",
      }),
    ],
  });

  expect(result.characterStates?.[0].locationKey).toBe("harbor");
});

it("adds knowledge keys from a command result knowledge_reveal event", () => {
  const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default" });
  const result = reduceWorldEvents({
    previousSnapshot,
    reducerVersion: 1,
    previousCharacterStates: [makeCharacterState({ agentId: "agent-default", locationKey: "start" })],
    events: [
      event({
        id: "wevt-remember",
        sequence: 1,
        type: "knowledge_reveal",
        actorIds: ["agent-default"],
        payload: { factKey: "secret:harbor-password", summary: "The harbor password clue is a silver bell." },
        summary: "The harbor password clue is a silver bell.",
      }),
    ],
  });

  expect(result.characterStates?.[0].knowledgeKeys).toContain("secret:harbor-password");
});
```

### Appendix L: End-To-End World Loop Integration Test

Create `ui/src/server/flow/world-loop-integration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { createWorldMindFlow } from "./world-mind-flow";
import { drainWorldTickTasks } from "./world-tick-worker";
import { drainActorCommandTasks } from "./actor-command-worker";

describe("WorldMind long-running loop", () => {
  it("runs accepted user action, scheduled tick, and actor command without duplicate events", async () => {
    const db = createTestDatabase();
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const envelope = new WorldRunRepository(db).createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-1",
    });

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "go inspect the harbor", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        modelProvider: "test",
        modelName: "test-director",
        rawDecisionJson: "{}",
        decision: {
          observations: [],
          intent: "dispatch_commands",
          events: [
            {
              clientEventId: "evt-1",
              type: "world_incident",
              actorIds: ["agent-default"],
              payload: {
                title: "Harbor clue",
                description: "A light flickers at the harbor.",
                unresolved: true,
                factKey: "harbor-light",
              },
              visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
              summary: "A light flickers at the harbor.",
            },
          ],
          commands: [
            {
              commandType: "move_location",
              targetAgentId: "agent-default",
              priority: "normal",
              visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
              actorInstruction: "Move to the harbor.",
              privateReason: null,
              cause: { type: "proposed_event", clientEventId: "evt-1" },
              payload: { locationKey: "harbor" },
              relatedEventSummary: "A light flickers at the harbor.",
            },
          ],
          memories: [],
          nextTick: { delayMs: 30_000, reason: "follow harbor clue" },
        },
      }),
    });

    expect(new TaskRepository(db).claimNext({ kinds: ["world_tick"], workerId: "test", leaseMs: 1 })?.kind).toBe("world_tick");
    db.sqlite.prepare("UPDATE tasks SET status = 'pending', locked_by = NULL, locked_at = NULL, lock_expires_at = NULL").run();

    await drainWorldTickTasks({
      db,
      limit: 1,
      workerId: "tick-worker",
      createWorldMind: async () => ({
        validationStatus: "accepted",
        decisionLogId: "tick-log",
        createdEventIds: [],
        createdCommandIds: [],
        proposedEventIdToCommittedEventId: {},
      }),
    });
    await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    const events = new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" });
    expect(events.map((event) => event.type)).toEqual(["user_action", "world_incident", "character_action"]);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
    expect(new ActorCommandRepository(db).claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 })).toBeNull();
  });
});
```
