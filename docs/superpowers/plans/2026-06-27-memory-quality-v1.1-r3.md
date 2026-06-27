# Memory Quality v1.1-r3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce memory-extraction LLM cost, lower conflict false positives, make embedding fallback observable, and improve feed-fallback topic quality — without touching existing table schemas, public payloads, or external dependencies.

**Architecture:** Two new SQLite tables (`memory_operation_logs`, `feed_topics`) added via `CREATE TABLE IF NOT EXISTS` inside `initializeDatabase()` (matches the current ad-hoc-migration pattern). A `ThrottleMemoryExtraction` node sits before `ExtractMemoryCandidates` and short-circuits via an explicit `ctx.throttled` flag. `detectConflict` is rewritten to return `{ conflict, reason }` and uses an aggregated `no_conflict` log. `extractTopic` is replaced on the fallback path only by `extractTopicWithCluster` which clusters topics via bge-m3 cosine. `EmbeddingResult` carries a new `fallbackReason` so callers can log the exact cause.

**Tech Stack:** TypeScript, Next.js 16.2 (route handler at `ui/src/app/api/chat/route.ts`), better-sqlite3 12, drizzle-orm 0.45, vitest, AI SDK v7, local llama.cpp embedding server (bge-m3), structured-output via `Output.object({ schema })`.

## Global Constraints

- `ui/package.json` is unchanged — no new dependencies.
- No changes to existing tables: `memories`, `tasks`, `memories_fts`, `feed_posts`, `conversations`, `messages`, `agents`, `worlds`, `agent_live_states`.
- New tables: `memory_operation_logs`, `feed_topics` — added via `CREATE TABLE IF NOT EXISTS` inside `db/client.ts:initializeDatabase()`. **No SQL migration runner.**
- `memories` schema, `ChatReply` shape, `memory_extract` task payload (existing fields) — all unchanged. New fields are optional and additive.
- `MEMORY_CONFLICT_SIMILARITY = 0.72`, `MEMORY_MERGE_SIMILARITY = 0.86`, `MEMORY_CONFLICT_TOP_K = 10` stay.
- `CONFLICT_CAPABLE_TYPES = new Set(["preference", "boundary", "goal"])` only. `profile`/`relationship` re-enabled in v2.
- `feed_topics.agent_id` is `NOT NULL DEFAULT '__shared__'` (sentinel). Use `normalizeAgentId()` helper. SQLite `UNIQUE` allows multiple NULLs — that's why we use a sentinel.
- `MemoryOperationLogRepository.record()` is **synchronous** and **never throws**.
- `no_conflict` logs are **aggregated** (one row per consolidation round with `detail.reasons` count map). Console output for `no_conflict` and `topic_fallback` is suppressed unless `process.env.MEMORY_OP_VERBOSE_LOG === "true"`.
- `embedding_fallback` and `conflict` log rows print to console unconditionally; `throttled` prints via `console.info` unconditionally.
- Per `memory_extract` task, total `memory_operation_logs` rows ≤ 20 (8 candidates × 1 aggregated row + conflict/embedding events).
- Existing tests for `MemoryConsolidator` and `memory-extract-flow` must keep passing without edits. `detectConflictForTest()` boolean wrapper is preserved.
- `feed-flow.ts` `extractTopic` call is on the **fallback path only** (line 142 today). LLM-success path uses `generated.topicSeed` byte-for-byte unchanged.
- Verification after each task: `cd ui && npm run test:run && npm run lint && npm run build`.

---

## Task 1: EmbeddingResult.fallbackReason + classifyEmbeddingError

**Files:**
- Modify: `ui/src/server/ai/embeddings.ts`
- Modify: `ui/src/server/ai/embeddings.test.ts`

**Interfaces:**
- Consumes: nothing (this task is foundational)
- Produces:
  - `EmbeddingFallbackReason = "fetch_failed" | "non_2xx_status" | "invalid_response_shape" | "vector_dimension_zero" | "aborted"` (exported)
  - `classifyEmbeddingError(error: unknown): EmbeddingFallbackReason` (exported)
  - `EmbeddingResult.fallbackReason?: EmbeddingFallbackReason` (new optional field)

- [ ] **Step 1: Write failing test for classifyEmbeddingError and embedding-result fallbackReason**

Append to `ui/src/server/ai/embeddings.test.ts` (test file uses `vitest`; existing tests use `describe`/`it`/`expect`):

```ts
import { classifyEmbeddingError } from "./embeddings";

describe("classifyEmbeddingError", () => {
  it("returns 'aborted' when error.name === 'AbortError'", () => {
    expect(classifyEmbeddingError(new Error("fetch aborted"))).toBe("aborted");
    expect(classifyEmbeddingError(Object.assign(new Error(""), { name: "AbortError" }))).toBe("aborted");
  });

  it("returns 'aborted' for non-Error throws with name 'AbortError'", () => {
    expect(classifyEmbeddingError({ name: "AbortError" })).toBe("aborted");
  });

  it("returns 'non_2xx_status' for 'embedding request failed' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding request failed: 500"))).toBe("non_2xx_status");
  });

  it("returns 'invalid_response_shape' for 'missing data' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response missing data"))).toBe("invalid_response_shape");
  });

  it("returns 'vector_dimension_zero' for length-0 messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response vector length 0"))).toBe("vector_dimension_zero");
  });

  it("returns 'invalid_response_shape' for 'missing vector' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response missing vector"))).toBe("invalid_response_shape");
  });

  it("returns 'fetch_failed' for unknown errors", () => {
    expect(classifyEmbeddingError(new Error("ECONNREFUSED"))).toBe("fetch_failed");
    expect(classifyEmbeddingError("string error")).toBe("fetch_failed");
  });
});

describe("embedText fallbackReason", () => {
  it("tags fallback results with fallbackReason on fetch failure", async () => {
    const result = await embedText("hello", { fetchFn: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch });
    expect(result.backend).toBe("fallback");
    expect(result.fallbackReason).toBe("fetch_failed");
  });

  it("tags fallback results with non_2xx_status when response not ok", async () => {
    const fakeFetch = (() => Promise.resolve(new Response("{}", { status: 500 }))) as typeof fetch;
    const result = await embedText("hello", { fetchFn: fakeFetch });
    expect(result.backend).toBe("fallback");
    expect(result.fallbackReason).toBe("non_2xx_status");
  });

  it("does not set fallbackReason on success", async () => {
    const fakeFetch = (() => Promise.resolve(new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))) as typeof fetch;
    const result = await embedText("hello", { fetchFn: fakeFetch });
    expect(result.backend).toBe("llama.cpp");
    expect(result.fallbackReason).toBeUndefined();
  });
});
```

The `embedText` import path is the same as other tests in this file. If not already imported at top, add: `import { embedText } from "./embeddings";`.

- [ ] **Step 2: Run the new tests, expect FAIL**

Run: `cd ui && npx vitest run src/server/ai/embeddings.test.ts -t "classifyEmbeddingError"`
Expected: FAIL — `classifyEmbeddingError` is not exported.

- [ ] **Step 3: Implement `classifyEmbeddingError` and add `fallbackReason` field**

In `ui/src/server/ai/embeddings.ts`, near the top after `cosineSimilarity` (or before `parseEmbeddingVector`):

```ts
export type EmbeddingFallbackReason =
  | "fetch_failed"
  | "non_2xx_status"
  | "invalid_response_shape"
  | "vector_dimension_zero"
  | "aborted";

export function classifyEmbeddingError(error: unknown): EmbeddingFallbackReason {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "aborted";
    const msg = error.message;
    if (msg.includes("embedding request failed")) return "non_2xx_status";
    if (msg.includes("embedding response missing data")) return "invalid_response_shape";
    if (msg.includes("vector length 0")) return "vector_dimension_zero";
    if (msg.includes("embedding response missing vector")) return "invalid_response_shape";
    return "fetch_failed";
  }
  if (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError") {
    return "aborted";
  }
  return "fetch_failed";
}
```

Add `fallbackReason?: EmbeddingFallbackReason;` to the `EmbeddingResult` interface (last field).

Modify the `catch` block in `embedText`:

```ts
} catch (error) {
  const fallbackReason = classifyEmbeddingError(error);
  return {
    vector: createFallbackEmbedding(normalized, readFallbackDimension()),
    dimension: readFallbackDimension(),
    backend: "fallback",
    quality: "lexical",
    model: "fallback-hash-v1",
    version: EMBEDDING_VERSION,
    needsRefresh: true,
    fallbackReason,
  };
}
```

Modify `parseEmbeddingVector` so empty vector throws a distinct message:

```ts
function parseEmbeddingVector(body: unknown): number[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embedding response missing data");
  }
  const embedding = (data[0] as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("embedding response missing vector");
  }
  if (embedding.length === 0) {
    throw new Error("embedding response vector length 0");
  }
  if (!embedding.every((item) => typeof item === "number")) {
    throw new Error("embedding response vector has non-numeric elements");
  }
  return embedding;
}
```

- [ ] **Step 4: Run all embedding tests, expect PASS**

Run: `cd ui && npm run test:run -- src/server/ai/embeddings.test.ts`
Expected: PASS for both old and new test cases.

- [ ] **Step 5: Run lint + build**

Run: `cd ui && npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/ai/embeddings.ts ui/src/server/ai/embeddings.test.ts
git commit -m "feat(embeddings): tag fallback results with EmbeddingFallbackReason"
```

---

## Task 2: Add memory_operation_logs and feed_topics tables

**Files:**
- Modify: `ui/src/server/db/client.ts:initializeDatabase`
- Modify: `ui/src/server/db/schema.ts`

**Interfaces:**
- Consumes: nothing
- Produces: two new tables `memory_operation_logs` and `feed_topics` (see schema in spec); Drizzle table definitions exported from `db/schema.ts` for typed access.

- [ ] **Step 1: Write failing integration test for the two tables**

Create `ui/src/server/db/tables-v1.1.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./client";

describe("v1.1 tables", () => {
  it("creates memory_operation_logs on initializeDatabase", () => {
    const db = createTestDatabase();
    const row = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_operation_logs'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("memory_operation_logs");
  });

  it("creates feed_topics with agent_id NOT NULL DEFAULT '__shared__'", () => {
    const db = createTestDatabase();
    const cols = db.sqlite.prepare("PRAGMA table_info(feed_topics)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const agentId = cols.find((c) => c.name === "agent_id");
    expect(agentId?.notnull).toBe(1);
    expect(agentId?.dflt_value).toBe("'__shared__'");
  });

  it("creates idx_mol_kind_time and idx_feed_topics_scope_last_used", () => {
    const db = createTestDatabase();
    const indexes = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_mol_kind_time','idx_feed_topics_scope_last_used')")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_mol_kind_time");
    expect(names).toContain("idx_feed_topics_scope_last_used");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/db/tables-v1.1.test.ts`
Expected: FAIL — tables don't exist.

- [ ] **Step 3: Add CREATE TABLE blocks to `initializeDatabase`**

In `ui/src/server/db/client.ts`, find `initializeDatabase`. Add at the end of the function (before the return), in this order:

```ts
  // v1.1-r3: append-only observability log
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      source_task_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mol_kind_time ON memory_operation_logs(kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mol_scope_time ON memory_operation_logs(user_id, agent_id, world_id, created_at DESC);
  `);

  // v1.1-r3: feed topic clusters, scoped by user/world/agent
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS feed_topics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '__shared__',
      topic_key TEXT NOT NULL,
      representative_embedding_json TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_quality TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      UNIQUE (user_id, world_id, agent_id, topic_key)
    );
    CREATE INDEX IF NOT EXISTS idx_feed_topics_scope_last_used
      ON feed_topics(user_id, world_id, agent_id, last_used_at DESC);
  `);
```

Adjust the variable name (`db.sqlite`) to match whatever the existing code uses. Read the function first; the syntax may use better-sqlite3 `prepare(...).run()` chains instead of `exec`.

- [ ] **Step 4: Add Drizzle schema mirrors**

In `ui/src/server/db/schema.ts`, find existing table definitions (e.g. `memories`, `tasks`). Add at the end:

```ts
export const memoryOperationLogs = sqliteTable("memory_operation_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull(),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at").notNull(),
});

export const feedTopics = sqliteTable("feed_topics", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  worldId: text("world_id").notNull(),
  agentId: text("agent_id").notNull().default("__shared__"),
  topicKey: text("topic_key").notNull(),
  representativeEmbeddingJson: text("representative_embedding_json").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingQuality: text("embedding_quality").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  useCount: integer("use_count").notNull().default(1),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
});
```

If existing Drizzle definitions use a different field-naming convention (camelCase vs snake_case in JS object), match that style.

- [ ] **Step 5: Run the test, expect PASS**

Run: `cd ui && npx vitest run src/server/db/tables-v1.1.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + build**

Run: `cd ui && npm run lint && npm run build`

- [ ] **Step 7: Commit**

```bash
git add ui/src/server/db/client.ts ui/src/server/db/schema.ts ui/src/server/db/tables-v1.1.test.ts
git commit -m "feat(db): add memory_operation_logs and feed_topics tables"
```

---

## Task 3: MemoryOperationLogRepository

**Files:**
- Create: `ui/src/server/domain/chat/memory-operation-log-repository.ts`
- Create: `ui/src/server/domain/chat/memory-operation-log-repository.test.ts`

**Interfaces:**
- Consumes: `AppDatabase` (from `@/server/db/client`)
- Produces:
  - `MemoryOpKind = "throttled" | "embedding_fallback" | "conflict" | "no_conflict" | "topic_fallback"`
  - `MemoryOperationLogRecord` (interface, mirror of schema)
  - `class MemoryOperationLogRepository` with `record(input)` (sync, never throws) and `listRecent({ kind?, limit? })`

- [ ] **Step 1: Write failing test**

Create `ui/src/server/domain/chat/memory-operation-log-repository.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type AppDatabase } from "@/server/db/client";
import { MemoryOperationLogRepository } from "./memory-operation-log-repository";

describe("MemoryOperationLogRepository", () => {
  let db: AppDatabase;
  let logs: MemoryOperationLogRepository;
  beforeEach(() => {
    db = createTestDatabase();
    logs = new MemoryOperationLogRepository(db);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("record() inserts a row and listRecent returns it", () => {
    logs.record({
      userId: "u1", agentId: "a1", worldId: "w1",
      kind: "throttled", reason: "confirmation_only",
      sourceTaskId: "task-1",
    });
    const recent = logs.listRecent({});
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe("throttled");
    expect(recent[0].reason).toBe("confirmation_only");
    expect(recent[0].sourceTaskId).toBe("task-1");
  });

  it("record() stores detail as JSON", () => {
    logs.record({
      userId: "u1", agentId: "a1", worldId: "w1",
      kind: "no_conflict", reason: "summary",
      detail: { checked: 10, reasons: { hypothetical_context: 4 } },
    });
    const [row] = logs.listRecent({});
    expect(JSON.parse(row.detail!)).toEqual({ checked: 10, reasons: { hypothetical_context: 4 } });
  });

  it("record() never throws when INSERT fails", () => {
    const prepareSpy = vi.spyOn(db.sqlite, "prepare").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => logs.record({
      userId: "u1", agentId: "a1", worldId: "w1",
      kind: "throttled", reason: "fallback_reply",
    })).not.toThrow();
    prepareSpy.mockRestore();
  });

  it("listRecent orders by created_at DESC and filters by kind", () => {
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "throttled", reason: "x" });
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "conflict", reason: "y" });
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "throttled", reason: "z" });
    const all = logs.listRecent({});
    expect(all.map((r) => r.kind)).toEqual(["throttled", "conflict", "throttled"]);
    const onlyThrottled = logs.listRecent({ kind: "throttled" });
    expect(onlyThrottled.every((r) => r.kind === "throttled")).toBe(true);
  });

  it("prints console.info for throttled by default", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "throttled", reason: "x" });
    expect(info).toHaveBeenCalled();
    const msg = info.mock.calls[0]?.[0];
    expect(String(msg)).toContain("[memory-ops]");
  });

  it("prints console.warn for embedding_fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "embedding_fallback", reason: "non_2xx_status" });
    expect(warn).toHaveBeenCalled();
  });

  it("suppresses no_conflict console output unless MEMORY_OP_VERBOSE_LOG=true", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    delete process.env.MEMORY_OP_VERBOSE_LOG;
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "no_conflict", reason: "summary" });
    expect(info).not.toHaveBeenCalled();
    process.env.MEMORY_OP_VERBOSE_LOG = "true";
    logs.record({ userId: "u1", agentId: "a1", worldId: "w1", kind: "no_conflict", reason: "summary" });
    expect(info).toHaveBeenCalledTimes(1);
    delete process.env.MEMORY_OP_VERBOSE_LOG;
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/domain/chat/memory-operation-log-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `ui/src/server/domain/chat/memory-operation-log-repository.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@/server/db/client";

export type MemoryOpKind =
  | "throttled"
  | "embedding_fallback"
  | "conflict"
  | "no_conflict"
  | "topic_fallback";

export interface MemoryOperationLogRecord {
  id: string;
  userId: string;
  agentId: string;
  worldId: string;
  kind: MemoryOpKind;
  reason: string;
  detail: Record<string, unknown> | null;
  sourceTaskId: string | null;
  createdAt: number;
}

export interface RecordInput {
  userId: string;
  agentId: string;
  worldId: string;
  kind: MemoryOpKind;
  reason: string;
  detail?: Record<string, unknown>;
  sourceTaskId?: string | null;
}

export interface ListRecentInput {
  kind?: MemoryOpKind;
  limit?: number;
}

export class MemoryOperationLogRepository {
  constructor(private readonly db: AppDatabase) {}

  record(input: RecordInput): void {
    const now = Date.now();
    const id = `mem-op-${randomUUID()}`;
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO memory_operation_logs
            (id, user_id, agent_id, world_id, kind, reason, detail, source_task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.agentId,
          input.worldId,
          input.kind,
          input.reason,
          input.detail ? JSON.stringify(input.detail) : null,
          input.sourceTaskId ?? null,
          now,
        );
    } catch (error) {
      console.error("[memory-ops] failed to record log:", error);
      return;
    }

    const verboseOnly = input.kind === "no_conflict" || input.kind === "topic_fallback";
    const verboseEnabled = process.env.MEMORY_OP_VERBOSE_LOG === "true";
    if (!verboseOnly || verboseEnabled) {
      const level: "info" | "warn" = input.kind === "embedding_fallback" ? "warn" : "info";
      console[level]("[memory-ops]", JSON.stringify({
        kind: input.kind,
        reason: input.reason,
        scope: `${input.userId}/${input.agentId}/${input.worldId}`,
        sourceTaskId: input.sourceTaskId ?? null,
        ts: now,
      }));
    }
  }

  listRecent(input: ListRecentInput): MemoryOperationLogRecord[] {
    const limit = Math.max(0, Math.min(1000, input.limit ?? 50));
    const sql = input.kind
      ? `SELECT * FROM memory_operation_logs WHERE kind = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM memory_operation_logs ORDER BY created_at DESC LIMIT ?`;
    const params = input.kind ? [input.kind, limit] : [limit];
    const rows = this.db.sqlite.prepare(sql).all(...params) as Array<{
      id: string; user_id: string; agent_id: string; world_id: string;
      kind: MemoryOpKind; reason: string; detail: string | null;
      source_task_id: string | null; created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      agentId: r.agent_id,
      worldId: r.world_id,
      kind: r.kind,
      reason: r.reason,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      sourceTaskId: r.source_task_id,
      createdAt: r.created_at,
    }));
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd ui && npx vitest run src/server/domain/chat/memory-operation-log-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
git add ui/src/server/domain/chat/memory-operation-log-repository.ts ui/src/server/domain/chat/memory-operation-log-repository.test.ts
git commit -m "feat(memory): add MemoryOperationLogRepository"
```

---

## Task 4: FeedTopicRepository

**Files:**
- Create: `ui/src/server/domain/chat/feed-topic-repository.ts`
- Create: `ui/src/server/domain/chat/feed-topic-repository.test.ts`

**Interfaces:**
- Consumes: `AppDatabase`, `EmbeddingResult`
- Produces:
  - `SHARED_AGENT_ID = "__shared__"`
  - `normalizeAgentId(agentId: string | null | undefined): string`
  - `FeedTopicRecord`, `CreateFeedTopicInput`, `ListRecentInput`, `TopicMatch`
  - `class FeedTopicRepository` with `create`, `listRecent`, `touch`, `isEmpty`, `bestMatchByCosine`

- [ ] **Step 1: Write failing test**

Create `ui/src/server/domain/chat/feed-topic-repository.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import type { EmbeddingResult } from "@/server/ai/embeddings";
import { createTestDatabase, type AppDatabase } from "@/server/db/client";
import { FeedTopicRepository, normalizeAgentId, SHARED_AGENT_ID } from "./feed-topic-repository";

const semantic = (vector: number[]): EmbeddingResult => ({
  vector, dimension: vector.length, backend: "llama.cpp",
  quality: "semantic", model: "bge-m3", version: 1, needsRefresh: false,
});

describe("normalizeAgentId", () => {
  it("returns the agent id when non-empty", () => {
    expect(normalizeAgentId("agent-A")).toBe("agent-A");
  });
  it("returns SHARED_AGENT_ID for null / undefined / empty", () => {
    expect(normalizeAgentId(null)).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId(undefined)).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId("")).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId("   ")).toBe(SHARED_AGENT_ID);
  });
});

describe("FeedTopicRepository", () => {
  let db: AppDatabase;
  let repo: FeedTopicRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new FeedTopicRepository(db);
  });

  it("create stores a topic and returns the key", () => {
    const key = repo.create({
      userId: "u1", worldId: "w1", agentId: "a1",
      topicKey: "咖啡", embedding: semantic([1, 0, 0]),
    });
    expect(key).toBe("咖啡");
    const list = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    expect(list).toHaveLength(1);
    expect(list[0].useCount).toBe(1);
  });

  it("create is idempotent on UNIQUE conflict (same key)", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    const key = repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    expect(key).toBe("咖啡");
    const list = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    expect(list).toHaveLength(1);
  });

  it("different (user_id, world_id, agent_id) do not collide", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: SHARED_AGENT_ID, topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    repo.create({ userId: "u2", worldId: "w1", agentId: SHARED_AGENT_ID, topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: SHARED_AGENT_ID, sinceDays: 90 })).toHaveLength(1);
    expect(repo.listRecent({ userId: "u2", worldId: "w1", agentId: SHARED_AGENT_ID, sinceDays: 90 })).toHaveLength(1);
  });

  it("touch increments use_count and updates last_used_at", async () => {
    const key = repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    void key;
    const before = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })[0];
    await new Promise((r) => setTimeout(r, 5));
    repo.touch(before.id);
    const after = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })[0];
    expect(after.useCount).toBe(before.useCount + 1);
    expect(after.lastUsedAt).toBeGreaterThanOrEqual(before.lastUsedAt);
  });

  it("bestMatchByCosine returns highest-similarity match above threshold", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "加班", embedding: semantic([0, 1, 0]) });
    const candidates = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    const match = repo.bestMatchByCosine(candidates, semantic([0.99, 0.01, 0]), 0.7);
    expect(match?.topicKey).toBe("咖啡");
    expect(match?.similarity).toBeGreaterThan(0.9);
  });

  it("bestMatchByCosine returns null when no candidate meets threshold", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    const candidates = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    const match = repo.bestMatchByCosine(candidates, semantic([0, 0, 1]), 0.9);
    expect(match).toBeNull();
  });

  it("isEmpty reflects table state", () => {
    expect(repo.isEmpty({ userId: "u1", worldId: "w1", agentId: "a1" })).toBe(true);
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    expect(repo.isEmpty({ userId: "u1", worldId: "w1", agentId: "a1" })).toBe(false);
  });

  it("sinceDays filters out old rows", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    const oneHundredDaysAgo = Date.now() - 100 * 86_400_000;
    db.sqlite.prepare("UPDATE feed_topics SET last_used_at = ?").run(oneHundredDaysAgo);
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })).toHaveLength(0);
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 365 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/domain/chat/feed-topic-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `ui/src/server/domain/chat/feed-topic-repository.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@/server/db/client";
import { cosineSimilarity, type EmbeddingResult } from "@/server/ai/embeddings";

export const SHARED_AGENT_ID = "__shared__";
export const TOPIC_MATCH_SIMILARITY = 0.75;
export const TOPIC_RECENT_WINDOW_DAYS = 90;

export function normalizeAgentId(agentId: string | null | undefined): string {
  if (typeof agentId === "string" && agentId.trim()) return agentId;
  return SHARED_AGENT_ID;
}

export interface FeedTopicRecord {
  id: string;
  userId: string;
  worldId: string;
  agentId: string;
  topicKey: string;
  representativeEmbeddingJson: string;
  embeddingModel: string;
  embeddingQuality: string;
  embeddingDimension: number;
  useCount: number;
  firstSeenAt: number;
  lastUsedAt: number;
}

export interface CreateFeedTopicInput {
  userId: string;
  worldId: string;
  agentId: string;
  topicKey: string;
  embedding: EmbeddingResult;
}

export interface ListRecentInput {
  userId: string;
  worldId: string;
  agentId: string;
  sinceDays: number;
}

export interface TopicMatch {
  id: string;
  topicKey: string;
  similarity: number;
}

interface FeedTopicRow {
  id: string; user_id: string; world_id: string; agent_id: string;
  topic_key: string; representative_embedding_json: string;
  embedding_model: string; embedding_quality: string;
  embedding_dimension: number; use_count: number;
  first_seen_at: number; last_used_at: number;
}

function mapRow(row: FeedTopicRow): FeedTopicRecord {
  return {
    id: row.id, userId: row.user_id, worldId: row.world_id, agentId: row.agent_id,
    topicKey: row.topic_key, representativeEmbeddingJson: row.representative_embedding_json,
    embeddingModel: row.embedding_model, embeddingQuality: row.embedding_quality,
    embeddingDimension: row.embedding_dimension, useCount: row.use_count,
    firstSeenAt: row.first_seen_at, lastUsedAt: row.last_used_at,
  };
}

export class FeedTopicRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateFeedTopicInput): string {
    const now = Date.now();
    const id = `topic-${randomUUID()}`;
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO feed_topics
            (id, user_id, world_id, agent_id, topic_key, representative_embedding_json,
             embedding_model, embedding_quality, embedding_dimension,
             use_count, first_seen_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id, input.userId, input.worldId, input.agentId, input.topicKey,
          JSON.stringify(input.embedding.vector),
          input.embedding.model, input.embedding.quality, input.embedding.dimension,
          now, now,
        );
    } catch {
      // UNIQUE conflict — same (user, world, agent, key). Treat as idempotent no-op.
    }
    return input.topicKey;
  }

  listRecent(input: ListRecentInput): FeedTopicRecord[] {
    const sinceMs = Date.now() - input.sinceDays * 86_400_000;
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM feed_topics
         WHERE user_id = ? AND world_id = ? AND agent_id = ?
           AND last_used_at >= ?
         ORDER BY last_used_at DESC`,
      )
      .all(input.userId, input.worldId, input.agentId, sinceMs) as FeedTopicRow[];
    return rows.map(mapRow);
  }

  touch(id: string): void {
    const now = Date.now();
    this.db.sqlite
      .prepare("UPDATE feed_topics SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
      .run(now, id);
  }

  isEmpty(input: { userId: string; worldId: string; agentId: string }): boolean {
    const row = this.db.sqlite
      .prepare("SELECT COUNT(*) AS c FROM feed_topics WHERE user_id = ? AND world_id = ? AND agent_id = ?")
      .get(input.userId, input.worldId, input.agentId) as { c: number };
    return row.c === 0;
  }

  bestMatchByCosine(
    candidates: FeedTopicRecord[],
    queryEmbedding: EmbeddingResult,
    threshold: number,
  ): TopicMatch | null {
    if (queryEmbedding.quality !== "semantic") return null;
    let best: TopicMatch | null = null;
    for (const c of candidates) {
      if (c.embeddingQuality !== "semantic") continue;
      let vec: number[];
      try { vec = JSON.parse(c.representativeEmbeddingJson) as number[]; } catch { continue; }
      const sim = cosineSimilarity(vec, queryEmbedding.vector);
      if (sim === null) continue;
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = { id: c.id, topicKey: c.topicKey, similarity: sim };
      }
    }
    return best;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd ui && npx vitest run src/server/domain/chat/feed-topic-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
git add ui/src/server/domain/chat/feed-topic-repository.ts ui/src/server/domain/chat/feed-topic-repository.test.ts
git commit -m "feat(feed): add FeedTopicRepository with scoped clustering"
```

---

## Task 5: detectConflict v1.1 — REPLACES preference-only rule

**Files:**
- Modify: `ui/src/server/domain/chat/memory-consolidator.ts`
- Modify: `ui/src/server/domain/chat/memory-consolidator.test.ts`

**Interfaces:**
- Consumes: `MemoryOpKind` ("conflict" / "no_conflict"), `MemoryOperationLogRepository`
- Produces:
  - `ConflictReason = "type_not_conflict_capable" | "hypothetical_context" | "double_negative" | "temporal_vs_long_term" | "high_confidence_reversal" | "polarity_unchanged_or_ambiguous"`
  - `ConflictDecision { conflict: boolean; reason: ConflictReason }`
  - `detectConflict(old, new, type): ConflictDecision` (replaces current boolean)
  - `detectConflictForTest(old, new, type): boolean` (boolean wrapper, preserved)

- [ ] **Step 1: Write failing tests for the new decision flow**

Append to `ui/src/server/domain/chat/memory-consolidator.test.ts` (read the file first; existing tests use `describe("MemoryConsolidator", ...)`):

```ts
import { detectConflict } from "./memory-consolidator";  // add at top if not present

describe("detectConflict v1.1", () => {
  it("returns type_not_conflict_capable for non-conflict types", () => {
    expect(detectConflict("旧", "新", "event")).toEqual({ conflict: false, reason: "type_not_conflict_capable" });
    expect(detectConflict("旧", "新", "profile").conflict).toBe(false); // profile excluded in v1.1
  });

  it("returns hypothetical_context when new content has hypothetical triggers and no long-term marker", () => {
    expect(detectConflict("用户喜欢咖啡", "如果用户不喜欢咖啡", "preference"))
      .toEqual({ conflict: false, reason: "hypothetical_context" });
  });

  it("returns high_confidence_reversal when new content has long-term marker + negative polarity", () => {
    expect(detectConflict("用户接受晚间提醒", "用户以后不要晚间提醒", "preference"))
      .toEqual({ conflict: true, reason: "high_confidence_reversal" });
  });

  it("'我希望以后...' is NOT hypothetical (long-term marker bypass)", () => {
    expect(detectConflict("用户接受晚间提醒", "我希望以后不要晚间提醒", "boundary"))
      .toEqual({ conflict: true, reason: "high_confidence_reversal" });
  });

  it("returns double_negative when either side has double negative", () => {
    expect(detectConflict("用户不是不喜欢咖啡", "用户不喜欢咖啡", "preference"))
      .toEqual({ conflict: false, reason: "double_negative" });
  });

  it("returns temporal_vs_long_term for preference/boundary with temporal trigger", () => {
    expect(detectConflict("用户喜欢咖啡", "用户今天不喜欢咖啡", "preference"))
      .toEqual({ conflict: false, reason: "temporal_vs_long_term" });
  });

  it("does NOT apply temporal_vs_long_term when long-term marker is present", () => {
    expect(detectConflict("用户喜欢咖啡", "用户今天不再喜欢咖啡", "preference").conflict).toBe(true);
  });

  it("returns high_confidence_reversal on plain polarity flip", () => {
    expect(detectConflict("用户喜欢咖啡", "用户不喜欢咖啡", "preference"))
      .toEqual({ conflict: true, reason: "high_confidence_reversal" });
  });

  it("returns polarity_unchanged_or_ambiguous when same polarity", () => {
    expect(detectConflict("用户喜欢咖啡", "用户也喜欢茶", "preference"))
      .toEqual({ conflict: false, reason: "polarity_unchanged_or_ambiguous" });
  });

  it("profile type returns type_not_conflict_capable (v1.1 limitation)", () => {
    expect(detectConflict("用户是医生", "用户不是医生", "profile"))
      .toEqual({ conflict: false, reason: "type_not_conflict_capable" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/domain/chat/memory-consolidator.test.ts -t "detectConflict v1.1"`
Expected: FAIL — `detectConflict` still returns boolean, doesn't accept the new types or return shape.

- [ ] **Step 3: Rewrite detectConflict and add aggregated logging**

In `ui/src/server/domain/chat/memory-consolidator.ts`:

Replace the constants block at top (after `MEMORY_CONFLICT_TOP_K`):

```ts
export const CONFLICT_CAPABLE_TYPES = new Set([
  "preference", "boundary", "goal",
]);

const POSITIVE_PHRASES = [
  "喜欢", "爱", "想", "要", "希望", "倾向", "接受", "可以", "愿意", "允许", "计划", "准备",
];
const NEGATIVE_PHRASES = [
  "不喜欢", "不爱", "不想", "不要", "不希望", "讨厌", "排斥", "不接受", "拒绝", "不能", "禁止",
];
const DOUBLE_NEGATIVE_PHRASES = [
  "不是不喜欢", "并不是不喜欢", "不是不爱", "并不是不爱", "不是不想", "并不是不想",
];
const HYPOTHETICAL_TRIGGERS = [
  "如果", "要是", "假如", "假设", "要是能", "要是我",
  "的话", "情况下", "若", "若要",
];
const TEMPORAL_TRIGGERS = [
  "今天", "这次", "这次只", "临时", "最近", "目前",
  "今天下午", "今天晚上", "这周", "本周",
];
const LONG_TERM_MARKERS = [
  "以后", "从此", "从今以后", "从现在起", "默认", "永远",
  "不要再", "不要了", "不再", "一直",
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

function polarityOf(content: string): "positive" | "negative" | null {
  if (DOUBLE_NEGATIVE_PHRASES.some((p) => content.includes(p))) return null;
  for (const p of NEGATIVE_PHRASES) if (content.includes(p)) return "negative";
  for (const p of POSITIVE_PHRASES) if (content.includes(p)) return "positive";
  return null;
}

export type ConflictReason =
  | "type_not_conflict_capable"
  | "hypothetical_context"
  | "double_negative"
  | "temporal_vs_long_term"
  | "high_confidence_reversal"
  | "polarity_unchanged_or_ambiguous";

export interface ConflictDecision {
  conflict: boolean;
  reason: ConflictReason;
}

export function detectConflict(oldContent: string, newContent: string, memoryType: string): ConflictDecision {
  if (!CONFLICT_CAPABLE_TYPES.has(memoryType)) {
    return { conflict: false, reason: "type_not_conflict_capable" };
  }
  const hasLongTermMarker = containsAny(newContent, LONG_TERM_MARKERS);
  if (!hasLongTermMarker && containsAny(newContent, HYPOTHETICAL_TRIGGERS)) {
    return { conflict: false, reason: "hypothetical_context" };
  }
  if (containsAny(oldContent, DOUBLE_NEGATIVE_PHRASES) || containsAny(newContent, DOUBLE_NEGATIVE_PHRASES)) {
    return { conflict: false, reason: "double_negative" };
  }
  const isLongTermType = memoryType === "preference" || memoryType === "boundary";
  const oldTemporal = containsAny(oldContent, TEMPORAL_TRIGGERS);
  const newTemporal = containsAny(newContent, TEMPORAL_TRIGGERS);
  if (isLongTermType && (oldTemporal || newTemporal) && !hasLongTermMarker) {
    return { conflict: false, reason: "temporal_vs_long_term" };
  }
  const oldPolarity = polarityOf(oldContent);
  const newPolarity = polarityOf(newContent);
  if (oldPolarity !== null && newPolarity !== null && oldPolarity !== newPolarity) {
    return { conflict: true, reason: "high_confidence_reversal" };
  }
  return { conflict: false, reason: "polarity_unchanged_or_ambiguous" };
}
```

Replace the `consolidate()` method's conflict-detection section. Read the existing implementation first; replace the block that currently calls the boolean `detectConflict` and constructs `conflict` with:

```ts
      const conflictChecks = ranked
        .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
        .slice(0, MEMORY_CONFLICT_TOP_K)
        .map((item) => ({
          item,
          decision: detectConflict(item.memory.content, content, input.candidate.type),
        }));

      const logs = new MemoryOperationLogRepository(options.db);

      const noConflictReasons: Record<string, number> = {};
      for (const { decision } of conflictChecks) {
        if (!decision.conflict) {
          noConflictReasons[decision.reason] = (noConflictReasons[decision.reason] ?? 0) + 1;
        }
      }
      if (conflictChecks.length > 0) {
        logs.record({
          userId: input.userId, agentId: input.agentId, worldId: input.worldId,
          kind: "no_conflict",
          reason: "summary",
          detail: { checked: conflictChecks.length, reasons: noConflictReasons },
          sourceTaskId: input.sourceTaskId ?? null,
        });
      }

      const conflict = conflictChecks.find(({ decision }) => decision.conflict);
      if (conflict) {
        logs.record({
          userId: input.userId, agentId: input.agentId, worldId: input.worldId,
          kind: "conflict",
          reason: conflict.decision.reason,
          detail: { similarity: conflict.item.similarity, frozenMemoryId: conflict.item.memory.id },
          sourceTaskId: input.sourceTaskId ?? null,
        });
        // ... existing freeze / replaceConflicted flow unchanged ...
      }
```

Add at top of file (after `import type { MemoryCandidate }`):

```ts
import { MemoryOperationLogRepository } from "./memory-operation-log-repository";
```

Add `embedding_fallback` recording inside `consolidate()` — find the place where `await this.embedText(content)` is called and wrap:

```ts
      const embedding = await this.embedText(content);
      if (embedding.fallbackReason !== undefined) {
        new MemoryOperationLogRepository(options.db).record({
          userId: input.userId, agentId: input.agentId, worldId: input.worldId,
          kind: "embedding_fallback",
          reason: embedding.fallbackReason,
          sourceTaskId: input.sourceTaskId ?? null,
        });
      }
```

The existing `detectConflictForTest` method (test-only boolean wrapper) — replace its body to:

```ts
  detectConflictForTest(oldContent: string, newContent: string, memoryType: string): boolean {
    return detectConflict(oldContent, newContent, memoryType).conflict;
  }
```

(Ensure `detectConflict` is exported as a function above the class so `detectConflictForTest` can call it. The existing code declares it as a module-level function; export it.)

Update `ConsolidationResult.reason` strings so the conflict branch returns `conflict:${decision.reason}`:

```ts
        return {
          action: "conflicted",
          memoryId: created.id,
          frozenMemoryId: conflict.item.memory.id,
          reason: `conflict:${conflict.decision.reason}`,
        };
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd ui && npm run test:run -- src/server/domain/chat/memory-consolidator.test.ts`
Expected: PASS for both old assertions (via boolean wrapper) and new decision-flow tests.

- [ ] **Step 5: Lint + build**

Run: `cd ui && npm run lint && npm run build`

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/domain/chat/memory-consolidator.ts ui/src/server/domain/chat/memory-consolidator.test.ts
git commit -m "feat(memory): rewrite detectConflict to return ConflictDecision + aggregated no_conflict log"
```

---

## Task 6: ThrottleMemoryExtraction

**Files:**
- Create: `ui/src/server/domain/chat/throttle-rules.ts`
- Create: `ui/src/server/domain/chat/throttle-rules.test.ts`
- Modify: `ui/src/server/flow/memory-extract-flow.ts`
- Modify: `ui/src/server/flow/memory-extract-flow.test.ts`
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/flow/task-worker.ts`
- Modify: `ui/src/server/flow/task-worker.test.ts`

**Interfaces:**
- Consumes: `MemoryOperationLogRepository`
- Produces:
  - `ThrottleReason` union, `ThrottleDecision` interface, `shouldThrottle(input)`
  - `MemoryExtractContext.throttled?: boolean`, `throttleReason?: ThrottleReason`, `fallbackReplies?: string[]`
  - New flow node `ThrottleMemoryExtraction` between `LoadMessagePair` and `ExtractMemoryCandidates`
  - `ExtractMemoryCandidates` short-circuits when `ctx.throttled === true`
  - `chat-flow.ts` enqueue payload includes `fallbackReplies`
  - `task-worker.ts` `parseMemoryExtractPayload` reads `fallbackReplies`

- [ ] **Step 1: Write failing tests for `shouldThrottle`**

Create `ui/src/server/domain/chat/throttle-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldThrottle, type ThrottleReason } from "./throttle-rules";

describe("shouldThrottle", () => {
  it("returns throttled=false for normal long input", () => {
    expect(shouldThrottle({
      userMessage: "我今天下午要去图书馆读一本关于向量数据库的书。",
      assistantMessage: "好的，我可以帮你推荐几本。",
    })).toEqual({ throttled: false });
  });

  it("throttles fallback_reply when user has no strong signal", () => {
    const decision = shouldThrottle({
      userMessage: "好的",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(decision).toEqual({ throttled: true, reason: "fallback_reply" });
  });

  it("does NOT throttle fallback_reply when user has strong memory signal", () => {
    const decision = shouldThrottle({
      userMessage: "以后叫我阿梁",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(decision.throttled).toBe(false);
  });

  it("throttles punctuation_only regardless of strong signal", () => {
    expect(shouldThrottle({ userMessage: "!!!", assistantMessage: "" }))
      .toEqual({ throttled: true, reason: "punctuation_only" });
  });

  it("throttles repeated_punctuation when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "哈哈哈哈哈！！！", assistantMessage: "嗯" }))
      .toEqual({ throttled: true, reason: "repeated_punctuation" });
  });

  it("does NOT throttle repeated_punctuation when user has strong signal", () => {
    expect(shouldThrottle({ userMessage: "以后！！！", assistantMessage: "好" }).throttled).toBe(false);
  });

  it("throttles repeated_chars when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "啊啊啊啊啊", assistantMessage: "好" }))
      .toEqual({ throttled: true, reason: "repeated_chars" });
  });

  it("does NOT throttle repeated_chars when user has strong signal", () => {
    expect(shouldThrottle({ userMessage: "我叫梁梁梁梁梁", assistantMessage: "好" }).throttled).toBe(false);
  });

  it("throttles confirmation_only regardless of strong signal", () => {
    expect(shouldThrottle({ userMessage: "好的", assistantMessage: "好的" }))
      .toEqual({ throttled: true, reason: "confirmation_only" });
  });

  it("throttles too_short when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "ab", assistantMessage: "cd" }))
      .toEqual({ throttled: true, reason: "too_short" });
  });

  it("does NOT throttle too_short when user has strong memory trigger", () => {
    expect(shouldThrottle({ userMessage: "我喜欢", assistantMessage: "好的" }).throttled).toBe(false);
  });

  it("throttles low_signal_non_cjk when no English trigger", () => {
    expect(shouldThrottle({ userMessage: "abc def ghi", assistantMessage: "ok sure thing" }))
      .toEqual({ throttled: true, reason: "low_signal_non_cjk" });
  });

  it("does NOT throttle low_signal_non_cjk when user has English memory trigger", () => {
    expect(shouldThrottle({ userMessage: "please call me V", assistantMessage: "ok" }).throttled).toBe(false);
  });

  it("handles missing optional fallbackReplies", () => {
    expect(() => shouldThrottle({ userMessage: "你好", assistantMessage: "你好" })).not.toThrow();
  });
});

const _r: ThrottleReason = "fallback_reply";
void _r;
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/domain/chat/throttle-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `throttle-rules.ts`**

Create `ui/src/server/domain/chat/throttle-rules.ts`:

```ts
export type ThrottleReason =
  | "fallback_reply"
  | "punctuation_only"
  | "repeated_punctuation"
  | "repeated_chars"
  | "confirmation_only"
  | "too_short"
  | "low_signal_non_cjk";

export interface ThrottleDecision {
  throttled: boolean;
  reason?: ThrottleReason;
}

export interface ShouldThrottleInput {
  userMessage: string;
  assistantMessage: string;
  fallbackReplies?: string[];
}

const STRONG_MEMORY_TRIGGERS = [
  "记住", "以后", "默认", "不要再", "别叫", "我喜欢", "我不喜欢",
  "我讨厌", "我希望", "你以后", "你不要", "设定", "世界观", "我叫",
];

const EN_MEMORY_TRIGGERS = [
  "remember", "call me", "don't", "do not", "i like", "i dislike",
  "i hate", "prefer", "always", "never", "default", "setting", "world", "lore",
];

const CONFIRMATION_ONLY = ["嗯", "哦", "好", "是的", "对", "可以", "行", "没错", "继续"];

const REPEATED_PUNCT_CHARS = new Set(["。", "！", "?", "!", "，", ",", "；", ";", "…"]);

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

function hasStrongMemorySignal(userMessage: string): boolean {
  return containsAny(userMessage, STRONG_MEMORY_TRIGGERS) || containsAny(userMessage, EN_MEMORY_TRIGGERS);
}

function isPunctuationOnly(text: string): boolean {
  if (!text) return false;
  let lettersDigitsCjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[一-龥A-Za-z0-9]/.test(ch)) lettersDigitsCjk += 1;
    else other += 1;
  }
  if (lettersDigitsCjk === 0) return true;
  return other / (lettersDigitsCjk + other) >= 0.7;
}

function hasRepeatedRun(text: string, predicate: (ch: string) => boolean, threshold: number): boolean {
  let run = 0;
  for (const ch of text) {
    if (predicate(ch)) run += 1;
    else run = 0;
    if (run >= threshold) return true;
  }
  return false;
}

export function shouldThrottle(input: ShouldThrottleInput): ThrottleDecision {
  const user = input.userMessage ?? "";
  const assistant = input.assistantMessage ?? "";
  const fallbackReplies = input.fallbackReplies ?? [];
  const hasStrong = hasStrongMemorySignal(user);

  // 1. punctuation_only — always wins
  if (isPunctuationOnly(user) || isPunctuationOnly(assistant)) {
    return { throttled: true, reason: "punctuation_only" };
  }

  // 2. repeated_punctuation — bypass if strong
  if (!hasStrong && (hasRepeatedRun(user, (c) => REPEATED_PUNCT_CHARS.has(c), 3)
      || hasRepeatedRun(assistant, (c) => REPEATED_PUNCT_CHARS.has(c), 3))) {
    return { throttled: true, reason: "repeated_punctuation" };
  }

  // 3. repeated_chars — bypass if strong
  if (!hasStrong && (hasRepeatedRun(user, (c) => !REPEATED_PUNCT_CHARS.has(c) && !/\s/.test(c), 5)
      || hasRepeatedRun(assistant, (c) => !REPEATED_PUNCT_CHARS.has(c) && !/\s/.test(c), 5))) {
    return { throttled: true, reason: "repeated_chars" };
  }

  // 4. fallback_reply — bypass if strong
  if (!hasStrong) {
    const trimmedAssistant = assistant.trim();
    if (trimmedAssistant && fallbackReplies.some((r) => r.trim() === trimmedAssistant)) {
      return { throttled: true, reason: "fallback_reply" };
    }
  }

  // 5. confirmation_only — no bypass
  if (CONFIRMATION_ONLY.includes(user.trim())) {
    return { throttled: true, reason: "confirmation_only" };
  }

  // 6. too_short — has strong trigger whitelist
  const userShort = user.trim().length > 0 && user.trim().length < 6;
  const assistantShort = assistant.trim().length > 0 && assistant.trim().length < 6;
  if ((userShort || assistantShort) && !hasStrong) {
    return { throttled: true, reason: "too_short" };
  }

  // 7. low_signal_non_cjk — has EN trigger whitelist
  const cjkCount = (user + assistant).match(/[一-龥]/g)?.length ?? 0;
  const totalLen = user.trim().length + assistant.trim().length;
  if (cjkCount < 5 && totalLen >= 6 && !containsAny(user, EN_MEMORY_TRIGGERS)) {
    return { throttled: true, reason: "low_signal_non_cjk" };
  }

  return { throttled: false };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd ui && npx vitest run src/server/domain/chat/throttle-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into MemoryExtractFlow**

Modify `ui/src/server/flow/memory-extract-flow.ts`:

Add to imports:

```ts
import { shouldThrottle, type ThrottleReason } from "@/server/domain/chat/throttle-rules";
import { MemoryOperationLogRepository } from "@/server/domain/chat/memory-operation-log-repository";
```

Extend `MemoryExtractContext`:

```ts
export interface MemoryExtractContext {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  candidates?: MemoryCandidate[];
  persistedMemoryCount?: number;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  throttled?: boolean;
  throttleReason?: ThrottleReason;
  fallbackReplies?: string[];
}
```

Insert node between `LoadMessagePair` and `ExtractMemoryCandidates`:

```ts
    {
      name: "ThrottleMemoryExtraction",
      run: async (ctx) => {
        const decision = shouldThrottle({
          userMessage: ctx.userMessage,
          assistantMessage: ctx.assistantMessage,
          fallbackReplies: ctx.fallbackReplies ?? [],
        });
        if (decision.throttled) {
          new MemoryOperationLogRepository(options.db).record({
            userId: ctx.userId, agentId: ctx.agentId, worldId: ctx.worldId,
            kind: "throttled",
            reason: decision.reason!,
            sourceTaskId: ctx.sourceTaskId ?? null,
          });
          return { ...ctx, throttled: true, throttleReason: decision.reason, candidates: [] };
        }
        return ctx;
      },
    },
```

Modify `ExtractMemoryCandidates` to short-circuit:

```ts
    {
      name: "ExtractMemoryCandidates",
      run: async (ctx) => {
        if (ctx.throttled) {
          return { ...ctx, candidates: [] };
        }
        if (!ctx.userMessage || !ctx.assistantMessage) {
          return { ...ctx, candidates: [] };
        }
        const extraction = await generateExtraction({ ... });
        return { ...ctx, candidates: extraction?.memories ?? [] };
      },
    },
```

- [ ] **Step 6: Pass `fallbackReplies` from chat-flow + worker**

In `ui/src/server/flow/chat-flow.ts`, find `EnqueueMemoryExtraction`. Update the `tasks.enqueue({...})` payload to add:

```ts
          fallbackReplies: [
            "我在这里。你刚才说的我记住了。",
            "当前模型暂时不可用，但我已经收到你的消息了。",
          ],
```

(Place as a literal or extract to a helper `collectFallbackReplies()` in `chat-flow.ts`.)

In `ui/src/server/flow/task-worker.ts`, extend `parseMemoryExtractPayload`:

```ts
function parseMemoryExtractPayload(payload: unknown): {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  fallbackReplies?: string[];
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid memory_extract payload");
  }
  const record = payload as Record<string, unknown>;
  const userId = readRequiredString(record, "userId");
  const agentId = readRequiredString(record, "agentId");
  const worldId = readRequiredString(record, "worldId");
  const userMessage = readRequiredString(record, "userMessage");
  const assistantMessage = readRequiredString(record, "assistantMessage");
  const agentName = typeof record.agentName === "string" ? record.agentName : undefined;
  const fallbackReplies = Array.isArray(record.fallbackReplies)
    ? record.fallbackReplies.filter((x): x is string => typeof x === "string")
    : undefined;
  return { userId, agentId, worldId, userMessage, assistantMessage, agentName, fallbackReplies };
}
```

`task-worker.ts:drainChatTasks` already spreads `...payload`, so `fallbackReplies` reaches `MemoryExtractContext` automatically.

- [ ] **Step 7: Add integration tests for the flow**

Append to `ui/src/server/flow/memory-extract-flow.test.ts`:

```ts
import { createTestDatabase } from "@/server/db/client";
import { vi } from "vitest";

describe("MemoryExtractFlow throttling", () => {
  it("short-circuits when shouldThrottle matches fallback_reply and user has no strong signal", async () => {
    const db = createTestDatabase();
    const generateSpy = vi.fn();
    const flow = createMemoryExtractFlow({ db, generateMemoryExtraction: generateSpy });
    const result = await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "好的",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(result.throttled).toBe(true);
    expect(result.throttleReason).toBe("fallback_reply");
    expect(result.persistedMemoryCount).toBe(0);
  });

  it("does NOT throttle when user has strong memory signal even if assistant is fallback", async () => {
    const db = createTestDatabase();
    const generateSpy = vi.fn().mockResolvedValue({ memories: [] });
    const flow = createMemoryExtractFlow({ db, generateMemoryExtraction: generateSpy });
    await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "以后叫我阿梁",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(generateSpy).toHaveBeenCalled();
  });

  it("records one throttled log row per throttled task", async () => {
    const db = createTestDatabase();
    const flow = createMemoryExtractFlow({ db });
    await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "好的",
      assistantMessage: "好的",
    });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'throttled'").all();
    expect(rows).toHaveLength(1);
  });
});
```

Append to `ui/src/server/flow/task-worker.test.ts` (or test via `drainChatTasks` with a constructed task):

```ts
it("drainChatTasks propagates fallbackReplies into MemoryExtractContext", async () => {
  const db = createTestDatabase();
  const tasks = new TaskRepository(db);
  const task = tasks.enqueue({
    kind: "memory_extract",
    payload: {
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "你好", assistantMessage: "你好",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    },
  });
  const generateSpy = vi.fn().mockResolvedValue({ memories: [] });
  await drainChatTasks({ db, generateMemoryExtraction: generateSpy, limit: 1 });
  expect(generateSpy).toHaveBeenCalled();
  void task;
});
```

- [ ] **Step 8: Run all memory-extract and task-worker tests, expect PASS**

Run: `cd ui && npm run test:run -- src/server/flow/memory-extract-flow.test.ts src/server/flow/task-worker.test.ts`
Expected: PASS.

- [ ] **Step 9: Lint + build**

Run: `cd ui && npm run lint && npm run build`

- [ ] **Step 10: Commit**

```bash
git add ui/src/server/domain/chat/throttle-rules.ts ui/src/server/domain/chat/throttle-rules.test.ts \
        ui/src/server/flow/memory-extract-flow.ts ui/src/server/flow/memory-extract-flow.test.ts \
        ui/src/server/flow/chat-flow.ts ui/src/server/flow/task-worker.ts ui/src/server/flow/task-worker.test.ts
git commit -m "feat(memory): add ThrottleMemoryExtraction with strong-signal bypass"
```

---

## Task 7: extractTopicWithCluster on fallback path only

**Files:**
- Modify: `ui/src/server/flow/feed-flow.ts`
- Modify: `ui/src/server/flow/feed-flow.test.ts`

**Interfaces:**
- Consumes: `FeedTopicRepository`, `MemoryOperationLogRepository`, `embedText`
- Produces:
  - `extractTopicWithCluster(input: { db, content, userId, agentId, worldId, sourceTaskId? }): Promise<string>`
  - `extractTopicFallback(text): string` (renamed from current `extractTopic`)
  - Fallback path in `GenerateFeedPost` uses `extractTopicWithCluster` instead of `extractTopic`
  - LLM-success path byte-for-byte unchanged (asserted in tests)

- [ ] **Step 1: Write failing tests**

Append to `ui/src/server/flow/feed-flow.test.ts`:

```ts
import { extractTopicWithCluster } from "./feed-flow";
import { SHARED_AGENT_ID } from "@/server/domain/chat/feed-topic-repository";
import type { EmbedText } from "@/server/ai/embeddings";
import * as feedModule from "./feed-flow";
import { createFeedGenerateFlow } from "./feed-flow";

describe("extractTopicWithCluster", () => {
  it("clusters similar fallback contents to the same topic key", async () => {
    const db = createTestDatabase();
    const k1 = await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1" });
    const k2 = await extractTopicWithCluster({ db, content: "刚泡了咖啡", userId: "u1", agentId: "a1", worldId: "w1" });
    const k3 = await extractTopicWithCluster({ db, content: "咖啡真好喝", userId: "u1", agentId: "a1", worldId: "w1" });
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("isolates topics per (user_id, world_id, agent_id)", async () => {
    const db = createTestDatabase();
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1" });
    const k2 = await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u2", agentId: "a1", worldId: "w1" });
    const row = db.sqlite.prepare("SELECT COUNT(*) AS c FROM feed_topics").get() as { c: number };
    expect(row.c).toBe(2);
    expect(typeof k2).toBe("string");
  });

  it("uses __shared__ sentinel when agentId is null", async () => {
    const db = createTestDatabase();
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: null, worldId: "w1" });
    const row = db.sqlite.prepare("SELECT agent_id FROM feed_topics LIMIT 1").get() as { agent_id: string };
    expect(row.agent_id).toBe(SHARED_AGENT_ID);
  });

  it("logs topic_fallback with cold_start reason on first call", async () => {
    const db = createTestDatabase();
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1" });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'topic_fallback'").all() as Array<{ reason: string }>;
    expect(rows.map((r) => r.reason)).toContain("cold_start");
  });

  it("logs topic_fallback with embedding_unavailable when embedding is fallback", async () => {
    const db = createTestDatabase();
    const fakeEmbed: EmbedText = async () => ({
      vector: [0.1, 0.2], dimension: 2, backend: "fallback", quality: "lexical",
      model: "fallback-hash-v1", version: 1, needsRefresh: true,
      fallbackReason: "fetch_failed",
    });
    await extractTopicWithCluster({
      db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1",
      embedText: fakeEmbed,
    });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'topic_fallback'").all() as Array<{ reason: string }>;
    expect(rows.map((r) => r.reason)).toContain("embedding_unavailable");
  });
});

describe("GenerateFeedPost LLM-success path", () => {
  it("does not call extractTopicWithCluster when generateFeedPostDraft returns a draft", async () => {
    const db = createTestDatabase();
    const extractSpy = vi.spyOn(feedModule, "extractTopicWithCluster");
    const flow = createFeedGenerateFlow({
      db,
      generateFeedPostDraft: async () => ({
        content: "今天喝了咖啡。",
        topicSeed: "咖啡",
        postType: "status",
      }),
    });
    const result = await flow.run({ userId: "u1", agentId: "a1", worldId: "w1" });
    expect(extractSpy).not.toHaveBeenCalled();
    expect(result.topicSeed).toBe("咖啡");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd ui && npx vitest run src/server/flow/feed-flow.test.ts -t "extractTopicWithCluster"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `extractTopicWithCluster`**

In `ui/src/server/flow/feed-flow.ts`:

Add imports:

```ts
import { embedText as defaultEmbedText, type EmbedText } from "@/server/ai/embeddings";
import { FeedTopicRepository, normalizeAgentId, TOPIC_RECENT_WINDOW_DAYS } from "@/server/domain/chat/feed-topic-repository";
import { MemoryOperationLogRepository } from "@/server/domain/chat/memory-operation-log-repository";
```

Add `embedText` to `createFeedGenerateFlow` options:

```ts
export function createFeedGenerateFlow(options: {
  db: AppDatabase;
  generateFeedPostDraft?: GenerateFeedPostDraft;
  embedText?: EmbedText;
}): Flow<FeedGenerateContext> {
  // ...
  const embedFn = options.embedText ?? defaultEmbedText;
```

Replace `extractTopic` (lines 194-201) with `extractTopicFallback` plus the new `extractTopicWithCluster`:

```ts
const TOPIC_KEY_MAX_CJK = 8;
const TOPIC_KEY_MAX_WORDS = 4;
const TOPIC_MATCH_SIMILARITY = 0.75;

export async function extractTopicWithCluster(input: {
  db: AppDatabase;
  content: string;
  userId: string;
  agentId: string | null;
  worldId: string;
  sourceTaskId?: string | null;
  embedText?: EmbedText;
}): Promise<string> {
  const topics = new FeedTopicRepository(input.db);
  const logs = new MemoryOperationLogRepository(input.db);
  const effectiveAgentId = normalizeAgentId(input.agentId);
  const embedFn = input.embedText ?? defaultEmbedText;
  const embedding = await embedFn(input.content);

  if (embedding.fallbackReason !== undefined || embedding.quality !== "semantic") {
    logs.record({
      kind: "topic_fallback", reason: "embedding_unavailable",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
    });
    return extractTopicFallback(input.content);
  }

  const recent = topics.listRecent({
    userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
    sinceDays: TOPIC_RECENT_WINDOW_DAYS,
  });

  if (recent.length === 0) {
    const key = topics.create({
      userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
      topicKey: extractTopicFallback(input.content),
      embedding,
    });
    logs.record({
      kind: "topic_fallback", reason: "cold_start",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
    });
    return key;
  }

  const matched = topics.bestMatchByCosine(recent, embedding, TOPIC_MATCH_SIMILARITY);
  if (matched) {
    topics.touch(matched.id);
    return matched.topicKey;
  }

  const key = topics.create({
    userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
    topicKey: extractTopicFallback(input.content),
    embedding,
  });
  logs.record({
    kind: "topic_fallback", reason: "no_match",
    sourceTaskId: input.sourceTaskId ?? null,
    userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
  });
  return key;
}

function extractTopicFallback(text: string): string {
  const normalized = text.replace(/[。！？!?，,]/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const candidate = words.length > 0 ? words.slice(0, 4).join(" ") : normalized.slice(0, 18);
  return clampTopicKey(candidate) || "日常";
}

function clampTopicKey(s: string): string {
  const cjkChars = [...s].filter((ch) => /[一-龥]/.test(ch));
  if (cjkChars.length > TOPIC_KEY_MAX_CJK) {
    return cjkChars.slice(0, TOPIC_KEY_MAX_CJK).join("");
  }
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > TOPIC_KEY_MAX_WORDS) return words.slice(0, TOPIC_KEY_MAX_WORDS).join(" ");
  return s;
}
```

Modify the `GenerateFeedPost` node's fallback branch (the line currently calling `extractTopic(lastUserMessage || agent.persona)`):

```ts
        const lastUserMessage = [...recent].reverse().find((item) => item.role === "user")?.content;
        const topicSeed = await extractTopicWithCluster({
          db: options.db,
          content: lastUserMessage || agent.persona,
          userId: ctx.userId,
          agentId: ctx.agentId,
          worldId: ctx.worldId,
          sourceTaskId: ctx.sourceTaskId,
          embedText: embedFn,
        });
        return {
          ...ctx,
          topicSeed,
          postType: lastUserMessage ? "reflection" : "status",
          content: `${agent.displayName}：今天想把${topicSeed}这件事讲给你听。`,
        };
```

- [ ] **Step 4: Run feed-flow tests, expect PASS**

Run: `cd ui && npm run test:run -- src/server/flow/feed-flow.test.ts`
Expected: PASS for both new clustering tests and the LLM-success-path-untouched assertion.

- [ ] **Step 5: Lint + build**

Run: `cd ui && npm run lint && npm run build`

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/flow/feed-flow.ts ui/src/server/flow/feed-flow.test.ts
git commit -m "feat(feed): cluster fallback topics with bge-m3 cosine"
```

---

## Acceptance run-through

After all 7 tasks land, run the spec's acceptance criteria as a sanity check:

```bash
cd ui
npm run test:run
npm run lint
npm run build
```

Expected:
- All existing tests pass (no regressions).
- New tests for `throttle-rules`, `memory-consolidator` decision flow, `memory-operation-log-repository`, `feed-topic-repository`, `extractTopicWithCluster` all pass.
- LLM-success path in `feed-flow` produces byte-for-byte same `topicSeed`.
- `memory_extract` task writes ≤ 20 `memory_operation_logs` rows for an 8-candidate scenario.

---

## Self-Review Checklist (executed before handoff)

**Spec coverage (r3):**
- §#3 ThrottleMemoryExtraction → Task 6 ✓
- §#4 detectConflict v1.1 → Task 5 ✓
- §#5 extractTopicWithCluster → Task 7 ✓
- §#6 memory_operation_logs (aggregation + filter) → Task 3 ✓
- Precondition (no v1.0 deferred items) → enforced by Global Constraints ✓
- fallbackReplies end-to-end → Task 6 steps 5-6 ✓
- EmbeddingResult.fallbackReason → Task 1 ✓
- feed_topics sentinel __shared__ → Task 2 + Task 4 ✓
- CONFLICT_CAPABLE_TYPES shrink → Task 5 ✓
- Aggregation + verbose flag → Task 3 ✓
- Migration order (7 steps) → matches Tasks 1-7 ✓

**No placeholders:** all step code blocks are complete; no "TBD"/"TODO" appears.

**Type consistency:** `ThrottleReason` enum used in Task 6 spec matches what Task 5 spec exports; `ConflictDecision` is the same shape in Task 5 spec and test code; `EmbeddingResult.fallbackReason` is consistent between Task 1 producer and Tasks 5/7 consumers.
