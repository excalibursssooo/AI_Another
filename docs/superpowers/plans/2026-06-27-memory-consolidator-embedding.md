# Embedding Memory Consolidator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedding-backed memory consolidation layer that prevents duplicate/stale memories while keeping the app SQLite-first and usable when llama.cpp is offline.

**Architecture:** Add an embedding adapter under `src/server/ai`, extend the SQLite/Drizzle memory schema, add transactional repository operations, then route `MemoryExtractFlow` through a domain-level `MemoryConsolidator`. Semantic merge/conflict uses llama.cpp embeddings only; fallback embeddings keep writes available but do not drive semantic decisions.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, better-sqlite3, Drizzle schema, llama.cpp OpenAI-compatible `/v1/embeddings`, SQLite transactions.

---

## File Structure

- Modify `ui/src/server/ai/schemas.ts`: add optional `key` and `topic` to `MemoryCandidateSchema`.
- Create `ui/src/server/ai/embeddings.ts`: llama.cpp embedding client, fallback embedding, cosine/hash helpers.
- Create `ui/src/server/ai/embeddings.test.ts`: embedding client and fallback tests.
- Modify `ui/src/server/db/schema.ts`: add embedding/canonical/source/supersession fields to `memories`.
- Modify `ui/src/server/db/client.ts`: add runtime `ALTER TABLE` migration for new memory columns.
- Modify `ui/src/server/domain/chat/repositories.ts`: extend memory types, mapping, create/list/update/replace transaction methods.
- Modify `ui/src/server/domain/chat/repositories.test.ts`: migration/repository/transaction tests.
- Create `ui/src/server/domain/chat/memory-consolidator.ts`: consolidation policy.
- Create `ui/src/server/domain/chat/memory-consolidator.test.ts`: merge/conflict/fallback/topK/transaction/concurrency behavior tests.
- Modify `ui/src/server/flow/memory-extract-flow.ts`: replace direct create with consolidator.
- Modify `ui/src/server/flow/memory-extract-flow.test.ts`: flow integration tests.
- Modify `ui/src/server/flow/task-worker.ts`: pass task id into flow as nullable `sourceTaskId`.
- Modify `ui/src/server/flow/task-worker.test.ts`: source task propagation test.
- Modify `README.md`: document llama.cpp embedding command and environment variables.

---

### Task 1: Extend Memory Candidate Schema

**Files:**
- Modify: `ui/src/server/ai/schemas.ts`
- Modify: `ui/src/server/ai/schemas.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add this test to `ui/src/server/ai/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryCandidateSchema } from "./schemas";

describe("MemoryCandidateSchema canonical fields", () => {
  it("accepts optional key and topic for memory consolidation", () => {
    const parsed = MemoryCandidateSchema.parse({
      subject: "user",
      type: "preference",
      key: "preference.reminder.evening",
      topic: "reminders",
      content: "用户不要晚上提醒。",
      importance: 0.8,
      confidence: 0.9,
    });

    expect(parsed.key).toBe("preference.reminder.evening");
    expect(parsed.topic).toBe("reminders");
  });

  it("still accepts legacy candidates without key or topic", () => {
    const parsed = MemoryCandidateSchema.parse({
      subject: "user",
      type: "profile",
      content: "用户使用 zsh。",
      importance: 0.6,
      confidence: 0.8,
    });

    expect(parsed.key).toBeUndefined();
    expect(parsed.topic).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/ai/schemas.test.ts
```

Expected: fail because `key` and `topic` are not accepted by `MemoryCandidateSchema`.

- [ ] **Step 3: Update the schema**

In `ui/src/server/ai/schemas.ts`, change `MemoryCandidateSchema` to:

```ts
export const MemoryCandidateSchema = z.object({
  subject: MemoryCandidateSubjectSchema,
  type: MemoryCandidateTypeSchema,
  key: z.string().trim().min(1).max(120).optional(),
  topic: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd ui
npm run test:run -- src/server/ai/schemas.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/server/ai/schemas.ts ui/src/server/ai/schemas.test.ts
git commit -m "feat(memory): add canonical fields to memory candidates"
```

---

### Task 2: Add Embedding Client With Safe Fallback

**Files:**
- Create: `ui/src/server/ai/embeddings.ts`
- Create: `ui/src/server/ai/embeddings.test.ts`

- [ ] **Step 1: Write failing embedding tests**

Create `ui/src/server/ai/embeddings.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cosineSimilarity,
  createFallbackEmbedding,
  embedText,
  hashEmbeddingText,
  normalizeEmbeddingText,
} from "./embeddings";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("embedText", () => {
  it("parses a llama.cpp OpenAI-compatible embedding response", async () => {
    vi.stubEnv("LLAMA_EMBEDDING_BASE_URL", "http://127.0.0.1:8080/v1");
    vi.stubEnv("LLAMA_EMBEDDING_MODEL", "bge-m3");
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })) as unknown as typeof fetch;

    const result = await embedText("用户喜欢雨天散步", { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "bge-m3", input: "用户喜欢雨天散步" }),
      }),
    );
    expect(result).toEqual({
      vector: [0.1, 0.2, 0.3],
      dimension: 3,
      backend: "llama.cpp",
      quality: "semantic",
      model: "bge-m3",
      version: 1,
      needsRefresh: false,
    });
  });

  it("returns deterministic fallback when llama.cpp request fails", async () => {
    vi.stubEnv("EMBEDDING_FALLBACK_DIMENSION", "8");
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const first = await embedText("用户喜欢雨天散步", { fetchFn });
    const second = await embedText("用户喜欢雨天散步", { fetchFn });

    expect(first.backend).toBe("fallback");
    expect(first.quality).toBe("lexical");
    expect(first.needsRefresh).toBe(true);
    expect(first.dimension).toBe(8);
    expect(first.vector).toEqual(second.vector);
  });
});

describe("embedding helpers", () => {
  it("normalizes and hashes text deterministically", () => {
    expect(normalizeEmbeddingText(" 用户  喜欢\n雨天散步 ")).toBe("用户 喜欢 雨天散步");
    expect(hashEmbeddingText("用户喜欢雨天散步")).toBe(hashEmbeddingText("用户喜欢雨天散步"));
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1])).toBeNull();
  });

  it("creates deterministic fallback embeddings", () => {
    const one = createFallbackEmbedding("用户喜欢咖啡", 8);
    const two = createFallbackEmbedding("用户喜欢咖啡", 8);
    expect(one).toEqual(two);
    expect(one).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/ai/embeddings.test.ts
```

Expected: fail because `embeddings.ts` does not exist.

- [ ] **Step 3: Implement the embedding client**

Create `ui/src/server/ai/embeddings.ts`:

```ts
import { createHash } from "node:crypto";

export type EmbeddingBackend = "llama.cpp" | "fallback";
export type EmbeddingQuality = "semantic" | "lexical" | "none";

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  backend: EmbeddingBackend;
  quality: EmbeddingQuality;
  model: string;
  version: number;
  needsRefresh: boolean;
}

export interface EmbedTextOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export const EMBEDDING_VERSION = 1;
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_FALLBACK_DIMENSION = 128;

export async function embedText(text: string, options: EmbedTextOptions = {}): Promise<EmbeddingResult> {
  const normalized = normalizeEmbeddingText(text);
  const baseUrl = (process.env.LLAMA_EMBEDDING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.LLAMA_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const fetchFn = options.fetchFn ?? fetch;

  try {
    const response = await fetchFn(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: normalized }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    const vector = parseEmbeddingVector(body);
    return {
      vector,
      dimension: vector.length,
      backend: "llama.cpp",
      quality: "semantic",
      model,
      version: EMBEDDING_VERSION,
      needsRefresh: false,
    };
  } catch {
    const dimension = readFallbackDimension();
    return {
      vector: createFallbackEmbedding(normalized, dimension),
      dimension,
      backend: "fallback",
      quality: "lexical",
      model: "fallback-hash-v1",
      version: EMBEDDING_VERSION,
      needsRefresh: true,
    };
  }
}

export function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(normalizeEmbeddingText(text)).digest("hex");
}

export function createFallbackEmbedding(text: string, dimension: number): number[] {
  const normalized = normalizeEmbeddingText(text);
  const safeDimension = Math.max(1, Math.min(4096, Math.trunc(dimension)));
  const vector = Array.from({ length: safeDimension }, () => 0);
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    const digest = createHash("sha256").update(token).digest();
    for (let index = 0; index < digest.length; index += 2) {
      const slot = digest[index] % safeDimension;
      vector[slot] += digest[index + 1] >= 128 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function parseEmbeddingVector(body: unknown): number[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embedding response missing data");
  }
  const embedding = (data[0] as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((item) => typeof item === "number")) {
    throw new Error("embedding response missing vector");
  }
  return embedding;
}

function readFallbackDimension(): number {
  const parsed = Number.parseInt(process.env.EMBEDDING_FALLBACK_DIMENSION || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_DIMENSION;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd ui
npm run test:run -- src/server/ai/embeddings.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/server/ai/embeddings.ts ui/src/server/ai/embeddings.test.ts
git commit -m "feat(ai): add llama embedding client"
```

---

### Task 3: Add Memory Embedding Columns and Runtime Migration

**Files:**
- Modify: `ui/src/server/db/schema.ts`
- Modify: `ui/src/server/db/client.ts`
- Modify: `ui/src/server/domain/chat/repositories.test.ts`

- [ ] **Step 1: Write the failing database migration test**

Add this test to `ui/src/server/domain/chat/repositories.test.ts`:

```ts
import { createTestDatabase } from "@/server/db/client";

describe("memory embedding schema", () => {
  it("initializes memory embedding and supersession columns", () => {
    const db = createTestDatabase();
    const columns = db.sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    for (const name of [
      "canonical_key",
      "topic",
      "embedding_json",
      "embedding_model",
      "embedding_backend",
      "embedding_quality",
      "embedding_dimension",
      "embedding_status",
      "embedding_text_hash",
      "embedding_version",
      "embedding_needs_refresh",
      "embedding_updated_at",
      "superseded_by",
      "superseded_reason",
      "last_observed_at",
      "source_message_id",
      "source_task_id",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/repositories.test.ts
```

Expected: fail because new columns are missing.

- [ ] **Step 3: Extend Drizzle schema**

In `ui/src/server/db/schema.ts`, add these fields to `memories`:

```ts
canonicalKey: text("canonical_key"),
topic: text("topic"),
embeddingJson: text("embedding_json"),
embeddingModel: text("embedding_model"),
embeddingBackend: text("embedding_backend"),
embeddingQuality: text("embedding_quality"),
embeddingDimension: integer("embedding_dimension"),
embeddingStatus: text("embedding_status").notNull().default("missing"),
embeddingTextHash: text("embedding_text_hash"),
embeddingVersion: integer("embedding_version").notNull().default(1),
embeddingNeedsRefresh: integer("embedding_needs_refresh").notNull().default(1),
embeddingUpdatedAt: integer("embedding_updated_at"),
supersededBy: text("superseded_by"),
supersededReason: text("superseded_reason"),
lastObservedAt: integer("last_observed_at"),
sourceMessageId: text("source_message_id"),
sourceTaskId: text("source_task_id"),
```

- [ ] **Step 4: Add runtime column migration**

In `ui/src/server/db/client.ts`, call a new migration after the `CREATE TABLE` block:

```ts
  migrateMemoryEmbeddingColumns(db);
  migrateAgentLiveStatesScope(db);
```

Add this helper:

```ts
function migrateMemoryEmbeddingColumns(db: AppDatabase): void {
  const columns = db.sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const addColumn = (name: string, definition: string) => {
    if (!names.has(name)) {
      db.sqlite.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
      names.add(name);
    }
  };

  addColumn("canonical_key", "TEXT");
  addColumn("topic", "TEXT");
  addColumn("embedding_json", "TEXT");
  addColumn("embedding_model", "TEXT");
  addColumn("embedding_backend", "TEXT");
  addColumn("embedding_quality", "TEXT");
  addColumn("embedding_dimension", "INTEGER");
  addColumn("embedding_status", "TEXT NOT NULL DEFAULT 'missing'");
  addColumn("embedding_text_hash", "TEXT");
  addColumn("embedding_version", "INTEGER NOT NULL DEFAULT 1");
  addColumn("embedding_needs_refresh", "INTEGER NOT NULL DEFAULT 1");
  addColumn("embedding_updated_at", "INTEGER");
  addColumn("superseded_by", "TEXT");
  addColumn("superseded_reason", "TEXT");
  addColumn("last_observed_at", "INTEGER");
  addColumn("source_message_id", "TEXT");
  addColumn("source_task_id", "TEXT");
}
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/repositories.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/db/schema.ts ui/src/server/db/client.ts ui/src/server/domain/chat/repositories.test.ts
git commit -m "feat(memory): add embedding metadata columns"
```

---

### Task 4: Extend Memory Repository With Embedding Metadata and Transactions

**Files:**
- Modify: `ui/src/server/domain/chat/repositories.ts`
- Modify: `ui/src/server/domain/chat/repositories.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add these tests to `ui/src/server/domain/chat/repositories.test.ts`:

```ts
import { MemoryRepository } from "@/server/domain/chat/repositories";

describe("MemoryRepository embedding metadata", () => {
  it("creates and reads embedding metadata", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);

    const created = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.weather.rain",
      topic: "rain",
      content: "用户喜欢雨天散步。",
      importance: 0.8,
      confidence: 0.9,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "hash-a",
        version: 1,
        needsRefresh: false,
        updatedAt: 123,
      },
      sourceTaskId: "task-1",
    });

    const [read] = memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" });
    expect(read.id).toBe(created.id);
    expect(read.key).toBe("preference.weather.rain");
    expect(read.topic).toBe("rain");
    expect(read.embeddingStatus).toBe("ready");
    expect(read.embeddingJson).toBe(JSON.stringify([1, 0]));
    expect(read.sourceTaskId).toBe("task-1");
  });

  it("atomically replaces a conflicting memory", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢咖啡。",
      importance: 0.6,
      confidence: 0.8,
    });

    const replacement = memories.replaceConflicted({
      oldMemoryId: old.id,
      reason: "preference reversal",
      newMemory: {
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        subject: "user",
        memoryType: "preference",
        content: "用户不喜欢咖啡。",
        importance: 0.9,
        confidence: 0.95,
      },
    });

    const rows = memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "all" });
    const frozen = rows.find((item) => item.id === old.id);
    expect(frozen?.status).toBe("frozen");
    expect(frozen?.supersededBy).toBe(replacement.id);
    expect(replacement.status).toBe("active");
  });

  it("merges an active memory with refreshed metadata", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢本地小模型。",
      importance: 0.5,
      confidence: 0.7,
    });

    const merged = memories.mergeMemory({
      memoryId: old.id,
      content: "用户偏好本地小模型，尤其是 10B 以下、能端侧 JSON 输出的模型。",
      importance: 0.9,
      confidence: 0.85,
      embedding: {
        json: JSON.stringify([0.5, 0.5]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "hash-b",
        version: 1,
        needsRefresh: false,
        updatedAt: 456,
      },
      lastObservedAt: 456,
    });

    expect(merged?.content).toContain("10B 以下");
    expect(merged?.importance).toBe(0.9);
    expect(merged?.embeddingStatus).toBe("ready");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/repositories.test.ts
```

Expected: fail because repository types/methods do not exist.

- [ ] **Step 3: Extend memory types and row mapping**

In `ui/src/server/domain/chat/repositories.ts`, extend `MemoryRecord`:

```ts
  key: string | null;
  topic: string | null;
  embeddingJson: string | null;
  embeddingModel: string | null;
  embeddingBackend: string | null;
  embeddingQuality: string | null;
  embeddingDimension: number | null;
  embeddingStatus: "missing" | "ready" | "fallback" | "stale" | "failed";
  embeddingTextHash: string | null;
  embeddingVersion: number;
  embeddingNeedsRefresh: boolean;
  embeddingUpdatedAt: number | null;
  supersededBy: string | null;
  supersededReason: string | null;
  lastObservedAt: number | null;
  sourceMessageId: string | null;
  sourceTaskId: string | null;
```

Add matching fields to `MemoryRow` using snake_case names and update `mapMemory()`.

- [ ] **Step 4: Add repository input helper types**

Near `MemoryRepository`, add:

```ts
interface MemoryEmbeddingInput {
  json: string;
  model: string;
  backend: string;
  quality: string;
  dimension: number;
  status: "missing" | "ready" | "fallback" | "stale" | "failed";
  textHash: string;
  version: number;
  needsRefresh: boolean;
  updatedAt: number;
}

interface CreateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  subject: string;
  memoryType: string;
  key?: string | null;
  topic?: string | null;
  content: string;
  importance: number;
  confidence: number;
  embedding?: MemoryEmbeddingInput;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  lastObservedAt?: number | null;
}
```

- [ ] **Step 5: Update `create()` to write new columns**

Change `MemoryRepository.create(input: CreateMemoryInput)` to insert all memory columns. Use `input.embedding` when present; otherwise store:

```ts
embedding_status = "missing"
embedding_version = 1
embedding_needs_refresh = 1
```

- [ ] **Step 6: Add `listActiveForScope()`**

Add:

```ts
listActiveForScope(input: { userId: string; agentId: string; worldId: string }): MemoryRecord[] {
  const rows = this.db.sqlite
    .prepare(
      `SELECT *
       FROM memories
       WHERE user_id = ?
         AND agent_id = ?
         AND world_id = ?
         AND status = 'active'
       ORDER BY updated_at DESC`,
    )
    .all(input.userId, input.agentId, input.worldId) as MemoryRow[];
  return rows.map(mapMemory);
}
```

- [ ] **Step 7: Add transactional `mergeMemory()` and `replaceConflicted()`**

Implement `mergeMemory()` with `this.db.sqlite.transaction(...)`.

Implement `replaceConflicted()` with `this.db.sqlite.transaction(...)` so create and freeze happen in one transaction. Insert the new memory first, then update old memory with `status='frozen'`, `superseded_by`, and `superseded_reason`. Return the new memory.

- [ ] **Step 8: Run focused tests**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/repositories.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add ui/src/server/domain/chat/repositories.ts ui/src/server/domain/chat/repositories.test.ts
git commit -m "feat(memory): add repository consolidation operations"
```

---

### Task 5: Implement MemoryConsolidator

**Files:**
- Create: `ui/src/server/domain/chat/memory-consolidator.ts`
- Create: `ui/src/server/domain/chat/memory-consolidator.test.ts`

- [ ] **Step 1: Write failing consolidator tests**

Create `ui/src/server/domain/chat/memory-consolidator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "./repositories";
import { MemoryConsolidator } from "./memory-consolidator";
import type { EmbeddingResult } from "@/server/ai/embeddings";

const semantic = (vector: number[]): EmbeddingResult => ({
  vector,
  dimension: vector.length,
  backend: "llama.cpp",
  quality: "semantic",
  model: "bge-m3",
  version: 1,
  needsRefresh: false,
});

const fallback = (vector: number[]): EmbeddingResult => ({
  vector,
  dimension: vector.length,
  backend: "fallback",
  quality: "lexical",
  model: "fallback-hash-v1",
  version: 1,
  needsRefresh: true,
});

describe("MemoryConsolidator", () => {
  it("merges high-similarity semantic memories", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.model.local",
      topic: "local models",
      content: "用户喜欢本地小模型。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "old",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const embedText = vi.fn(async () => semantic([0.99, 0.01]));
    const consolidator = new MemoryConsolidator({ db, embedText });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        key: "preference.model.local",
        topic: "local models",
        content: "用户偏好本地小模型，尤其是 10B 以下模型。",
        importance: 0.9,
        confidence: 0.8,
      },
    });

    expect(result.action).toBe("merged");
    const active = memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" });
    expect(active).toHaveLength(1);
    expect(active[0].content).toContain("10B 以下");
  });

  it("does not use fallback embeddings for semantic merge", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.food.coffee",
      topic: "coffee",
      content: "用户喜欢咖啡。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "fallback-hash-v1",
        backend: "fallback",
        quality: "lexical",
        dimension: 2,
        status: "fallback",
        textHash: "old",
        version: 1,
        needsRefresh: true,
        updatedAt: 1,
      },
    });
    const consolidator = new MemoryConsolidator({ db, embedText: async () => fallback([1, 0]) });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        key: "preference.food.tea",
        topic: "tea",
        content: "用户喜欢茶。",
        importance: 0.5,
        confidence: 0.7,
      },
    });

    expect(result.action).toBe("created");
    expect(memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" })).toHaveLength(2);
  });

  it("checks conflict across topK, not only best match", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      topic: "coffee",
      content: "用户喜欢咖啡馆工作。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([0.9, 0.1]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "one",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      topic: "coffee",
      content: "用户喜欢咖啡。",
      importance: 0.6,
      confidence: 0.8,
      embedding: {
        json: JSON.stringify([0.8, 0.2]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "two",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const consolidator = new MemoryConsolidator({ db, embedText: async () => semantic([0.82, 0.18]) });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        topic: "coffee",
        content: "用户不喜欢咖啡。",
        importance: 0.9,
        confidence: 0.95,
      },
    });

    expect(result.action).toBe("conflicted");
    const all = memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "all" });
    expect(all.find((item) => item.id === old.id)?.status).toBe("frozen");
  });

  it("does not treat 不喜欢 as both negative and positive", async () => {
    const db = createTestDatabase();
    const consolidator = new MemoryConsolidator({ db, embedText: async () => semantic([1, 0]) });

    expect(consolidator.detectConflictForTest("用户喜欢咖啡。", "用户不喜欢咖啡。", "preference")).toBe(true);
    expect(consolidator.detectConflictForTest("用户不喜欢咖啡。", "用户不是不喜欢咖啡。", "preference")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/memory-consolidator.test.ts
```

Expected: fail because `memory-consolidator.ts` does not exist.

- [ ] **Step 3: Implement consolidator constants and types**

Create `ui/src/server/domain/chat/memory-consolidator.ts` with:

```ts
import type { AppDatabase } from "@/server/db/client";
import { embedText as defaultEmbedText, cosineSimilarity, hashEmbeddingText } from "@/server/ai/embeddings";
import type { EmbeddingResult } from "@/server/ai/embeddings";
import type { MemoryCandidate } from "@/server/ai/schemas";
import { MemoryRecord, MemoryRepository } from "./repositories";

export const MEMORY_MERGE_SIMILARITY = 0.86;
export const MEMORY_CONFLICT_SIMILARITY = 0.72;
export const MEMORY_MERGED_CONTENT_MAX_LENGTH = 500;
export const MEMORY_CONFLICT_TOP_K = 10;

export type ConsolidationAction = "created" | "merged" | "conflicted" | "skipped";

export interface ConsolidateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  candidate: MemoryCandidate;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
}

export interface ConsolidationResult {
  action: ConsolidationAction;
  memoryId?: string;
  frozenMemoryId?: string;
  reason: string;
}

type EmbedText = typeof defaultEmbedText;
```

- [ ] **Step 4: Implement the class skeleton and embedding metadata conversion**

Add:

```ts
export class MemoryConsolidator {
  private readonly memories: MemoryRepository;
  private readonly embedText: EmbedText;

  constructor(options: { db: AppDatabase; embedText?: EmbedText }) {
    this.memories = new MemoryRepository(options.db);
    this.embedText = options.embedText ?? defaultEmbedText;
  }

  async consolidate(input: ConsolidateMemoryInput): Promise<ConsolidationResult> {
    const content = input.candidate.content.trim();
    if (!content) {
      return { action: "skipped", reason: "empty content" };
    }

    const embedding = await this.embedText(content);
    const embeddingInput = toEmbeddingInput(content, embedding);
    const comparable = this.memories
      .listActiveForScope(input)
      .filter((memory) => isComparable(memory, input.candidate));

    const ranked = rankComparable(comparable, embedding);
    const conflict = ranked
      .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
      .slice(0, MEMORY_CONFLICT_TOP_K)
      .find((item) => detectConflict(item.memory.content, content, input.candidate.type));

    if (conflict) {
      const created = this.memories.replaceConflicted({
        oldMemoryId: conflict.memory.id,
        reason: "deterministic conflict",
        newMemory: {
          userId: input.userId,
          agentId: input.agentId,
          worldId: input.worldId,
          subject: input.candidate.subject,
          memoryType: input.candidate.type,
          key: input.candidate.key,
          topic: input.candidate.topic,
          content,
          importance: input.candidate.importance,
          confidence: input.candidate.confidence,
          embedding: embeddingInput,
          sourceMessageId: input.sourceMessageId,
          sourceTaskId: input.sourceTaskId,
          lastObservedAt: Date.now(),
        },
      });
      return { action: "conflicted", memoryId: created.id, frozenMemoryId: conflict.memory.id, reason: "conflict" };
    }

    const best = ranked[0];
    if (best && best.similarity >= MEMORY_MERGE_SIMILARITY) {
      const mergedContent = mergeMemoryContent(best.memory, input.candidate);
      const mergedEmbedding = await this.embedText(mergedContent);
      const updated = this.memories.mergeMemory({
        memoryId: best.memory.id,
        content: mergedContent,
        importance: Math.max(best.memory.importance, input.candidate.importance),
        confidence: Math.max(best.memory.confidence, input.candidate.confidence),
        key: input.candidate.key ?? best.memory.key,
        topic: input.candidate.topic ?? best.memory.topic,
        embedding: toEmbeddingInput(mergedContent, mergedEmbedding),
        lastObservedAt: Date.now(),
      });
      return { action: "merged", memoryId: updated?.id, reason: "similar semantic memory" };
    }

    const created = this.memories.create({
      userId: input.userId,
      agentId: input.agentId,
      worldId: input.worldId,
      subject: input.candidate.subject,
      memoryType: input.candidate.type,
      key: input.candidate.key,
      topic: input.candidate.topic,
      content,
      importance: input.candidate.importance,
      confidence: input.candidate.confidence,
      embedding: embeddingInput,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      lastObservedAt: Date.now(),
    });
    return { action: "created", memoryId: created.id, reason: "no comparable semantic memory" };
  }

  detectConflictForTest(oldContent: string, newContent: string, memoryType: string): boolean {
    return detectConflict(oldContent, newContent, memoryType);
  }
}
```

- [ ] **Step 5: Implement helper functions**

Add helpers for:

```ts
function toEmbeddingInput(content: string, result: EmbeddingResult) {
  return {
    json: JSON.stringify(result.vector),
    model: result.model,
    backend: result.backend,
    quality: result.quality,
    dimension: result.dimension,
    status: result.quality === "semantic" ? ("ready" as const) : ("fallback" as const),
    textHash: hashEmbeddingText(content),
    version: result.version,
    needsRefresh: result.needsRefresh,
    updatedAt: Date.now(),
  };
}
```

Implement `isComparable()`, `rankComparable()`, `parseVector()`, `detectConflict()`, `hasPositive()`, `hasNegative()`, and `mergeMemoryContent()`.

Rules:

- `rankComparable()` only ranks rows where existing memory and candidate embedding are semantic.
- fallback rows are not ranked.
- `detectConflict()` matches negative phrases before positive phrases.
- `detectConflict()` returns false for `不是不喜欢`.
- `mergeMemoryContent()` uses contains checks first, then type-aware fallback and boundary-aware clamp.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd ui
npm run test:run -- src/server/domain/chat/memory-consolidator.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/server/domain/chat/memory-consolidator.ts ui/src/server/domain/chat/memory-consolidator.test.ts
git commit -m "feat(memory): consolidate extracted memories"
```

---

### Task 6: Integrate Consolidator Into MemoryExtractFlow

**Files:**
- Modify: `ui/src/server/flow/memory-extract-flow.ts`
- Modify: `ui/src/server/flow/memory-extract-flow.test.ts`
- Modify: `ui/src/server/flow/task-worker.ts`
- Modify: `ui/src/server/flow/task-worker.test.ts`

- [ ] **Step 1: Write failing flow integration test**

Update `ui/src/server/flow/memory-extract-flow.test.ts` so the existing persistence test expects consolidation behavior:

```ts
it("consolidates extracted candidates instead of direct inserting duplicates", async () => {
  const db = createTestDatabase();
  const flow = createMemoryExtractFlow({
    db,
    generateMemoryExtraction: async () => ({
      memories: [
        {
          subject: "user",
          type: "preference",
          key: "preference.weather.rain",
          topic: "rain",
          content: "用户喜欢雨天散步。",
          importance: 0.8,
          confidence: 0.9,
        },
        {
          subject: "user",
          type: "preference",
          key: "preference.weather.rain",
          topic: "rain",
          content: "用户喜欢雨天散步。",
          importance: 0.7,
          confidence: 0.8,
        },
      ],
    }),
    embedText: async () => ({
      vector: [1, 0],
      dimension: 2,
      backend: "llama.cpp",
      quality: "semantic",
      model: "bge-m3",
      version: 1,
      needsRefresh: false,
    }),
  });

  const result = await flow.run({
    userId: "u001",
    agentId: "agent-default",
    worldId: "default",
    userMessage: "我喜欢雨天散步",
    assistantMessage: "我记住了。",
    sourceTaskId: "task-1",
  });

  expect(result.persistedMemoryCount).toBe(2);
  const memories = new MemoryRepository(db).listActiveForScope({
    userId: "u001",
    agentId: "agent-default",
    worldId: "default",
  });
  expect(memories).toHaveLength(1);
  expect(memories[0].sourceTaskId).toBe("task-1");
});
```

- [ ] **Step 2: Run focused test and verify it fails**

Run:

```bash
cd ui
npm run test:run -- src/server/flow/memory-extract-flow.test.ts
```

Expected: fail because flow does not accept `embedText` and still directly creates memories.

- [ ] **Step 3: Update flow types and options**

In `ui/src/server/flow/memory-extract-flow.ts`:

- remove direct `MemoryRepository` construction;
- import `MemoryConsolidator`;
- import `embedText` type as needed;
- add `sourceMessageId?: string | null` and `sourceTaskId?: string | null` to `MemoryExtractContext`;
- add optional `embedText` to `createMemoryExtractFlow()` options.

- [ ] **Step 4: Replace `PersistMemories` with `ConsolidateMemories`**

Replace the final node with:

```ts
{
  name: "ConsolidateMemories",
  run: async (ctx) => {
    const candidates = (ctx.candidates ?? []).filter((candidate) => candidate.content.trim()).slice(0, 8);
    const consolidator = new MemoryConsolidator({ db: options.db, embedText: options.embedText });
    let persistedMemoryCount = 0;
    for (const candidate of candidates) {
      const result = await consolidator.consolidate({
        userId: ctx.userId,
        agentId: ctx.agentId,
        worldId: ctx.worldId,
        candidate,
        sourceMessageId: ctx.sourceMessageId ?? null,
        sourceTaskId: ctx.sourceTaskId ?? null,
      });
      if (result.action === "created" || result.action === "merged" || result.action === "conflicted") {
        persistedMemoryCount += 1;
      }
    }
    return { ...ctx, persistedMemoryCount };
  },
}
```

- [ ] **Step 5: Pass task id from worker**

In `ui/src/server/flow/task-worker.ts`, after parsing payload, pass source task id:

```ts
await createMemoryExtractFlow({
  db: options.db,
  generateMemoryExtraction: options.generateMemoryExtraction,
}).run({ ...payload, sourceTaskId: task.id });
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd ui
npm run test:run -- src/server/flow/memory-extract-flow.test.ts src/server/flow/task-worker.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/server/flow/memory-extract-flow.ts ui/src/server/flow/memory-extract-flow.test.ts ui/src/server/flow/task-worker.ts ui/src/server/flow/task-worker.test.ts
git commit -m "feat(memory): route extraction through consolidator"
```

---

### Task 7: Add README Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add llama.cpp embedding documentation**

In `README.md`, add a subsection under environment variables or local startup:

````md
## 本地 Embedding 服务

长期记忆合并可以使用本地 llama.cpp embedding server。默认地址是 `http://127.0.0.1:8080/v1`。

```bash
cd ~/llama.cpp

./build/bin/llama-server \
  -m ~/models/embeddings/bge-m3/bge-m3-q8_0.gguf \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ngl 999 \
  --host 127.0.0.1 \
  --port 8080
```

相关环境变量：

```env
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
LLAMA_EMBEDDING_MODEL=bge-m3
LLAMA_EMBEDDING_TIMEOUT_MS=5000
EMBEDDING_FALLBACK_DIMENSION=128
EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=false
```

如果服务未启动，系统会写入 fallback embedding 并标记需要刷新；fallback 不参与默认语义合并。
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document local embedding server"
```

---

### Task 8: Full Verification

**Files:**
- No source changes unless verification exposes a concrete defect.

- [ ] **Step 1: Run full tests**

Run:

```bash
cd ui
npm run test:run
```

Expected: all test files pass.

- [ ] **Step 2: Run lint**

Run:

```bash
cd ui
npm run lint
```

Expected: exit 0.

- [ ] **Step 3: Run production build**

Run:

```bash
cd ui
npm run build
```

Expected: exit 0.

- [ ] **Step 4: Run smoke chat**

Run:

```bash
cd ui
npm run smoke:chat
```

Expected: prints `smoke chat ok: ...`.

- [ ] **Step 5: Optional llama.cpp smoke**

Only run this if the local embedding server is already started:

```bash
cd ui
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1 npm run test:run -- src/server/ai/embeddings.test.ts
```

Expected: pass. Unit tests must still pass without this service.

- [ ] **Step 6: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional changes are present. Do not stage unrelated `.gitignore` edits unless they are part of the current task.

---

## Self-Review Notes

- Spec coverage: tasks cover embedding quality, fallback constraints, schema fields, lazy migration primitives, repository transactions, topK conflict detection, canonical key/topic, flow integration, docs, and verification.
- Completion-marker scan: no task uses unfinished marker language.
- Type consistency: `MemoryCandidate.key/topic`, `EmbeddingResult.quality/version/needsRefresh`, `MemoryRepository.mergeMemory`, and `MemoryRepository.replaceConflicted` are consistently named across tasks.
