# WorldMind Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 WorldMind event ledger and replayable reducer foundation.

**Architecture:** Phase 1 creates only the durable event ledger, latest/checkpoint snapshot storage, a deterministic reducer, and a replay service. It does not integrate with ChatFlow, actor commands, world ticks, world memory, or real LLM generation. Events are replayed only by `sequence`, and snapshots are derived from committed events.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, better-sqlite3, Drizzle schema definitions, SQLite.

---

## Phase 1 Scope

Implement only:

- `world_events`
- `world_state_snapshots`
- `world_event_repository`
- `world_state_repository`
- `world_reducer`
- `world_replay_service`
- deterministic sequence allocation

Do not implement:

- `actor_commands`
- `WorldMindFlow`
- `WorldInteractionFlow`
- `ChatContext.worldDirective`
- `world_decision_logs`
- `world_memories`
- task queue lease upgrades
- background tick
- real model calls

## File Structure

Create:

- `ui/src/server/domain/world/types.ts`  
  Owns shared Phase 1 world types: event records, snapshot records, visibility scope, reducer input/output, payload types.

- `ui/src/server/domain/world/world-event-repository.ts`  
  Owns event sequence allocation, idempotent event insertion, and committed event reads ordered by `sequence`.

- `ui/src/server/domain/world/world-event-repository.test.ts`  
  Tests event idempotency, stable ordering, and sequence allocation.

- `ui/src/server/domain/world/world-state-repository.ts`  
  Owns snapshot insertions and latest snapshot lookup. Keeps one `is_latest = 1` row per user/world.

- `ui/src/server/domain/world/world-state-repository.test.ts`  
  Tests same-tick snapshots by `applied_event_sequence` and latest uniqueness.

- `ui/src/server/domain/world/world-reducer.ts`  
  Owns deterministic event-to-state reduction.

- `ui/src/server/domain/world/world-reducer.test.ts`  
  Tests initial state, `user_action`, `observed_only`, `world_incident`, and sequence-order behavior.

- `ui/src/server/domain/world/world-replay-service.ts`  
  Owns rebuild-from-ledger behavior.

- `ui/src/server/domain/world/world-replay-service.test.ts`  
  Tests snapshot rebuild from committed events.

Modify:

- `ui/src/server/db/client.ts`  
  Adds runtime SQLite table/index creation for `world_events` and `world_state_snapshots`.

- `ui/src/server/db/schema.ts`  
  Adds Drizzle table definitions for `worldEvents` and `worldStateSnapshots`.

- `ui/src/server/db/tables-world-phase1.test.ts`  
  New DB initialization tests for Phase 1 tables and indexes.

---

### Task 1: Add Phase 1 Database Tables

**Files:**
- Modify: `ui/src/server/db/client.ts`
- Modify: `ui/src/server/db/schema.ts`
- Create: `ui/src/server/db/tables-world-phase1.test.ts`

- [ ] **Step 1: Write failing table initialization tests**

Create `ui/src/server/db/tables-world-phase1.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "./client";

describe("world phase 1 tables", () => {
  it("creates world_events with replay and idempotency columns", () => {
    const db = createTestDatabase();
    const columns = db.sqlite.prepare("PRAGMA table_info(world_events)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain("decision_id");
    expect(names).toContain("world_run_id");
    expect(names).toContain("user_id");
    expect(names).toContain("world_id");
    expect(names).toContain("tick");
    expect(names).toContain("sequence");
    expect(names).toContain("schema_version");
    expect(names).toContain("reducer_version");
    expect(names).toContain("payload_json");
    expect(names).toContain("idempotency_key");
    expect(columns.find((column) => column.name === "sequence")?.notnull).toBe(1);
    expect(columns.find((column) => column.name === "idempotency_key")?.notnull).toBe(1);
  });

  it("creates world_events unique indexes for sequence and idempotency", () => {
    const db = createTestDatabase();
    const indexes = db.sqlite.prepare("PRAGMA index_list(world_events)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const uniqueNames = indexes.filter((index) => index.unique === 1).map((index) => index.name);

    expect(uniqueNames).toContain("world_events_user_world_sequence_uidx");
    expect(uniqueNames).toContain("world_events_idempotency_uidx");
  });

  it("creates world_state_snapshots with latest partial index", () => {
    const db = createTestDatabase();
    const columns = db.sqlite.prepare("PRAGMA table_info(world_state_snapshots)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain("snapshot_kind");
    expect(names).toContain("is_latest");
    expect(names).toContain("applied_event_sequence");
    expect(names).toContain("applied_event_ids_json");
    expect(names).toContain("state_json");
    expect(columns.find((column) => column.name === "is_latest")?.dflt_value).toBe("0");

    const indexes = db.sqlite.prepare("PRAGMA index_list(world_state_snapshots)").all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: "latest_world_snapshot_idx",
        unique: 1,
        partial: 1,
      }),
    );
  });
});
```

- [ ] **Step 2: Run the failing DB table tests**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase1.test.ts
```

Expected: fail because `world_events` and `world_state_snapshots` do not exist.

- [ ] **Step 3: Add runtime SQLite tables and indexes**

In `ui/src/server/db/client.ts`, inside the `initializeDatabase(db)` `db.sqlite.exec(\`...\`)` block after `feed_topics`, add:

```sql
    -- WorldMind phase 1: event ledger
    CREATE TABLE IF NOT EXISTS world_events (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      world_run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      tick INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      reducer_version INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      visibility TEXT NOT NULL,
      visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      visible_to_user INTEGER NOT NULL DEFAULT 0,
      actor_ids_json TEXT NOT NULL DEFAULT '[]',
      location_key TEXT,
      caused_by_event_id TEXT,
      caused_by_user_action_id TEXT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS world_events_user_world_sequence_uidx
      ON world_events(user_id, world_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS world_events_idempotency_uidx
      ON world_events(idempotency_key);
    CREATE INDEX IF NOT EXISTS world_events_replay_idx
      ON world_events(user_id, world_id, status, sequence);

    -- WorldMind phase 1: replay snapshots
    CREATE TABLE IF NOT EXISTS world_state_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      tick INTEGER NOT NULL,
      snapshot_kind TEXT NOT NULL DEFAULT 'latest',
      is_latest INTEGER NOT NULL DEFAULT 0,
      applied_event_sequence INTEGER NOT NULL,
      applied_event_ids_json TEXT NOT NULL,
      reducer_version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      checksum TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS world_state_snapshots_kind_sequence_uidx
      ON world_state_snapshots(user_id, world_id, snapshot_kind, applied_event_sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS latest_world_snapshot_idx
      ON world_state_snapshots(user_id, world_id)
      WHERE is_latest = 1;
```

- [ ] **Step 4: Add Drizzle schema definitions**

In `ui/src/server/db/schema.ts`, add table definitions after `feedTopics`:

```typescript
export const worldEvents = sqliteTable("world_events", {
  id: text("id").primaryKey(),
  decisionId: text("decision_id").notNull(),
  worldRunId: text("world_run_id").notNull(),
  userId: text("user_id").notNull(),
  worldId: text("world_id").notNull(),
  tick: integer("tick").notNull(),
  sequence: integer("sequence").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  reducerVersion: integer("reducer_version").notNull().default(1),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  summary: text("summary").notNull(),
  visibility: text("visibility").notNull(),
  visibleToActorIdsJson: text("visible_to_actor_ids_json").notNull().default("[]"),
  visibleToUser: integer("visible_to_user").notNull().default(0),
  actorIdsJson: text("actor_ids_json").notNull().default("[]"),
  locationKey: text("location_key"),
  causedByEventId: text("caused_by_event_id"),
  causedByUserActionId: text("caused_by_user_action_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const worldStateSnapshots = sqliteTable("world_state_snapshots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  worldId: text("world_id").notNull(),
  tick: integer("tick").notNull(),
  snapshotKind: text("snapshot_kind").notNull().default("latest"),
  isLatest: integer("is_latest").notNull().default(0),
  appliedEventSequence: integer("applied_event_sequence").notNull(),
  appliedEventIdsJson: text("applied_event_ids_json").notNull(),
  reducerVersion: integer("reducer_version").notNull(),
  stateJson: text("state_json").notNull(),
  checksum: text("checksum"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 5: Verify DB table tests pass**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase1.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit DB table work**

Run:

```bash
git add ui/src/server/db/client.ts ui/src/server/db/schema.ts ui/src/server/db/tables-world-phase1.test.ts
git commit -m "feat(world): add phase 1 ledger tables"
```

---

### Task 2: Add World Domain Types

**Files:**
- Create: `ui/src/server/domain/world/types.ts`

- [ ] **Step 1: Create the domain directory and type module**

Create `ui/src/server/domain/world/types.ts`:

```typescript
export type VisibilityLevel = "public" | "private" | "hidden";

export interface VisibilityScope {
  level: VisibilityLevel;
  visibleToActorIds: string[];
  visibleToUser: boolean;
}

export type WorldEventType =
  | "user_action"
  | "world_incident"
  | "character_action"
  | "relationship_shift"
  | "knowledge_reveal"
  | "arc_progress"
  | "system_note";

export type WorldEventStatus = "committed" | "rejected" | "superseded";

export interface UserActionPayload {
  clientActionId: string;
  normalizedMessage: string;
  targetAgentId: string;
  interpretationStatus: "pending" | "accepted" | "observed_only";
  failureReason?: "model_failed" | "validation_failed";
}

export interface WorldIncidentPayload {
  title: string;
  description: string;
  tensionDelta?: number;
  stabilityDelta?: number;
  unresolved?: boolean;
  factKey?: string;
}

export interface WorldFact {
  factKey: string;
  summary: string;
  visibility: VisibilityScope;
  sourceEventId: string;
}

export interface WorldRuntimeState {
  clock: {
    day: number;
    phase: "dawn" | "day" | "dusk" | "night";
    updatedAt: number;
  };
  stability: number;
  tension: number;
  activeArcIds: string[];
  publicFacts: WorldFact[];
  hiddenFacts: WorldFact[];
  unresolvedEventIds: string[];
}

export interface WorldEventRecord {
  id: string;
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  tick: number;
  sequence: number;
  schemaVersion: number;
  reducerVersion: number;
  type: WorldEventType;
  payload: unknown;
  summary: string;
  visibility: VisibilityScope;
  actorIds: string[];
  locationKey: string | null;
  causedByEventId: string | null;
  causedByUserActionId: string | null;
  idempotencyKey: string;
  status: WorldEventStatus;
  createdAt: number;
}

export interface WorldStateSnapshotRecord {
  id: string;
  userId: string;
  worldId: string;
  tick: number;
  snapshotKind: "latest" | "checkpoint" | "rebuild";
  isLatest: boolean;
  appliedEventSequence: number;
  appliedEventIds: string[];
  reducerVersion: number;
  state: WorldRuntimeState;
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorldReducerInput {
  previousSnapshot: WorldStateSnapshotRecord;
  events: WorldEventRecord[];
  reducerVersion: number;
}

export interface WorldReductionResult {
  worldSnapshot: WorldStateSnapshotRecord;
  appliedEventIds: string[];
  warnings: string[];
}

export const PUBLIC_VISIBILITY: VisibilityScope = {
  level: "public",
  visibleToActorIds: [],
  visibleToUser: true,
};
```

- [ ] **Step 2: Run TypeScript build for type validation**

Run:

```bash
cd ui && npm run build
```

Expected: pass.

- [ ] **Step 3: Commit domain types**

Run:

```bash
git add ui/src/server/domain/world/types.ts
git commit -m "feat(world): add phase 1 domain types"
```

---

### Task 3: Add World Event Repository

**Files:**
- Create: `ui/src/server/domain/world/world-event-repository.ts`
- Create: `ui/src/server/domain/world/world-event-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `ui/src/server/domain/world/world-event-repository.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { PUBLIC_VISIBILITY } from "./types";
import { WorldEventRepository } from "./world-event-repository";

describe("WorldEventRepository", () => {
  it("allocates monotonically increasing sequence per user and world", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    expect(events.allocateNextSequence({ userId: "u001", worldId: "default" })).toBe(1);
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "user said hello",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });

    expect(events.allocateNextSequence({ userId: "u001", worldId: "default" })).toBe(2);
    expect(events.allocateNextSequence({ userId: "u002", worldId: "default" })).toBe(1);
  });

  it("returns existing event for duplicate idempotency key", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    const first = events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "user said hello",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });
    const second = events.createCommitted({
      decisionId: "decision-2",
      worldRunId: "run-2",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 2,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello again",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "duplicate",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });

    expect(second.id).toBe(first.id);
    expect(second.sequence).toBe(1);
    expect(second.summary).toBe("user said hello");
  });

  it("lists committed events by sequence rather than created_at", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 2,
      type: "world_incident",
      payload: { title: "second", description: "second event" },
      summary: "second",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "event-2",
    });
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "first",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "first",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "event-1",
    });

    expect(events.listCommitted({ userId: "u001", worldId: "default" }).map((event) => event.sequence)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the failing repository tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-event-repository.test.ts
```

Expected: fail because `world-event-repository.ts` does not exist.

- [ ] **Step 3: Implement `WorldEventRepository`**

Create `ui/src/server/domain/world/world-event-repository.ts`:

```typescript
import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { VisibilityScope, WorldEventRecord, WorldEventType } from "./types";

interface WorldEventRow {
  id: string;
  decision_id: string;
  world_run_id: string;
  user_id: string;
  world_id: string;
  tick: number;
  sequence: number;
  schema_version: number;
  reducer_version: number;
  type: WorldEventType;
  payload_json: string;
  summary: string;
  visibility: VisibilityScope["level"];
  visible_to_actor_ids_json: string;
  visible_to_user: number;
  actor_ids_json: string;
  location_key: string | null;
  caused_by_event_id: string | null;
  caused_by_user_action_id: string | null;
  idempotency_key: string;
  status: WorldEventRecord["status"];
  created_at: number;
}

export interface CreateCommittedWorldEventInput {
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  tick: number;
  sequence: number;
  type: WorldEventType;
  payload: unknown;
  summary: string;
  visibility: VisibilityScope;
  actorIds: string[];
  idempotencyKey: string;
  locationKey?: string | null;
  causedByEventId?: string | null;
  causedByUserActionId?: string | null;
  schemaVersion?: number;
  reducerVersion?: number;
}

export class WorldEventRepository {
  constructor(private readonly db: AppDatabase) {}

  allocateNextSequence(input: { userId: string; worldId: string }): number {
    const row = this.db.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM world_events WHERE user_id = ? AND world_id = ?")
      .get(input.userId, input.worldId) as { next_sequence: number };
    return row.next_sequence;
  }

  createCommitted(input: CreateCommittedWorldEventInput): WorldEventRecord {
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const id = `wevt-${randomUUID()}`;
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO world_events
          (id, decision_id, world_run_id, user_id, world_id, tick, sequence, schema_version, reducer_version,
           type, payload_json, summary, visibility, visible_to_actor_ids_json, visible_to_user, actor_ids_json,
           location_key, caused_by_event_id, caused_by_user_action_id, idempotency_key, status, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      )
      .run(
        id,
        input.decisionId,
        input.worldRunId,
        input.userId,
        input.worldId,
        input.tick,
        input.sequence,
        input.schemaVersion ?? 1,
        input.reducerVersion ?? 1,
        input.type,
        JSON.stringify(input.payload),
        input.summary,
        input.visibility.level,
        JSON.stringify(input.visibility.visibleToActorIds),
        input.visibility.visibleToUser ? 1 : 0,
        JSON.stringify(input.actorIds),
        input.locationKey ?? null,
        input.causedByEventId ?? null,
        input.causedByUserActionId ?? null,
        input.idempotencyKey,
        now,
      );
    return this.getById(id) ?? (this.getByIdempotencyKey(input.idempotencyKey) as WorldEventRecord);
  }

  getById(id: string): WorldEventRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM world_events WHERE id = ?").get(id) as WorldEventRow | undefined;
    return row ? mapWorldEvent(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): WorldEventRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM world_events WHERE idempotency_key = ?")
      .get(idempotencyKey) as WorldEventRow | undefined;
    return row ? mapWorldEvent(row) : null;
  }

  listCommitted(input: { userId: string; worldId: string }): WorldEventRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM world_events
         WHERE user_id = ?
           AND world_id = ?
           AND status = 'committed'
         ORDER BY sequence ASC`,
      )
      .all(input.userId, input.worldId) as WorldEventRow[];
    return rows.map(mapWorldEvent);
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapWorldEvent(row: WorldEventRow): WorldEventRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    worldRunId: row.world_run_id,
    userId: row.user_id,
    worldId: row.world_id,
    tick: row.tick,
    sequence: row.sequence,
    schemaVersion: row.schema_version,
    reducerVersion: row.reducer_version,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    summary: row.summary,
    visibility: {
      level: row.visibility,
      visibleToActorIds: parseJson(row.visible_to_actor_ids_json, []),
      visibleToUser: row.visible_to_user === 1,
    },
    actorIds: parseJson(row.actor_ids_json, []),
    locationKey: row.location_key,
    causedByEventId: row.caused_by_event_id,
    causedByUserActionId: row.caused_by_user_action_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run repository tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-event-repository.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit event repository**

Run:

```bash
git add ui/src/server/domain/world/world-event-repository.ts ui/src/server/domain/world/world-event-repository.test.ts
git commit -m "feat(world): add event ledger repository"
```

---

### Task 4: Add World State Repository

**Files:**
- Create: `ui/src/server/domain/world/world-state-repository.ts`
- Create: `ui/src/server/domain/world/world-state-repository.test.ts`

- [ ] **Step 1: Write failing snapshot repository tests**

Create `ui/src/server/domain/world/world-state-repository.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { createInitialWorldSnapshot, WorldStateRepository } from "./world-state-repository";

describe("WorldStateRepository", () => {
  it("saves and loads the latest snapshot", () => {
    const db = createTestDatabase();
    const snapshots = new WorldStateRepository(db);
    const initial = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });

    const saved = snapshots.saveLatest({
      ...initial,
      appliedEventSequence: 1,
      appliedEventIds: ["event-1"],
    });

    expect(saved.isLatest).toBe(true);
    expect(snapshots.getLatest({ userId: "u001", worldId: "default" })?.appliedEventSequence).toBe(1);
  });

  it("allows multiple snapshots in one tick by applied event sequence", () => {
    const db = createTestDatabase();
    const snapshots = new WorldStateRepository(db);
    const initial = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });

    snapshots.saveLatest({ ...initial, tick: 0, appliedEventSequence: 1, appliedEventIds: ["event-1"] });
    const second = snapshots.saveLatest({ ...initial, tick: 0, appliedEventSequence: 2, appliedEventIds: ["event-1", "event-2"] });

    expect(second.tick).toBe(0);
    expect(second.appliedEventSequence).toBe(2);
    expect(snapshots.getLatest({ userId: "u001", worldId: "default" })?.appliedEventSequence).toBe(2);

    const rows = db.sqlite
      .prepare("SELECT applied_event_sequence, is_latest FROM world_state_snapshots WHERE user_id = ? AND world_id = ? ORDER BY applied_event_sequence")
      .all("u001", "default") as Array<{ applied_event_sequence: number; is_latest: number }>;
    expect(rows).toEqual([
      { applied_event_sequence: 1, is_latest: 0 },
      { applied_event_sequence: 2, is_latest: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the failing snapshot tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-state-repository.test.ts
```

Expected: fail because the repository does not exist.

- [ ] **Step 3: Implement `WorldStateRepository`**

Create `ui/src/server/domain/world/world-state-repository.ts`:

```typescript
import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { WorldRuntimeState, WorldStateSnapshotRecord } from "./types";

interface WorldStateSnapshotRow {
  id: string;
  user_id: string;
  world_id: string;
  tick: number;
  snapshot_kind: "latest" | "checkpoint" | "rebuild";
  is_latest: number;
  applied_event_sequence: number;
  applied_event_ids_json: string;
  reducer_version: number;
  state_json: string;
  checksum: string | null;
  created_at: number;
  updated_at: number;
}

export function createInitialWorldState(now = Date.now()): WorldRuntimeState {
  return {
    clock: { day: 1, phase: "day", updatedAt: now },
    stability: 0.5,
    tension: 0,
    activeArcIds: [],
    publicFacts: [],
    hiddenFacts: [],
    unresolvedEventIds: [],
  };
}

export function createInitialWorldSnapshot(input: {
  userId: string;
  worldId: string;
  now?: number;
}): WorldStateSnapshotRecord {
  const now = input.now ?? Date.now();
  const state = createInitialWorldState(now);
  return {
    id: `wsnap-${randomUUID()}`,
    userId: input.userId,
    worldId: input.worldId,
    tick: 0,
    snapshotKind: "latest",
    isLatest: true,
    appliedEventSequence: 0,
    appliedEventIds: [],
    reducerVersion: 1,
    state,
    checksum: checksumState(state),
    createdAt: now,
    updatedAt: now,
  };
}

export class WorldStateRepository {
  constructor(private readonly db: AppDatabase) {}

  getLatest(input: { userId: string; worldId: string }): WorldStateSnapshotRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM world_state_snapshots WHERE user_id = ? AND world_id = ? AND is_latest = 1")
      .get(input.userId, input.worldId) as WorldStateSnapshotRow | undefined;
    return row ? mapSnapshot(row) : null;
  }

  saveLatest(input: WorldStateSnapshotRecord): WorldStateSnapshotRecord {
    const result = this.db.sqlite.transaction(() => {
      const now = Date.now();
      const id = `wsnap-${randomUUID()}`;
      const stateJson = JSON.stringify(input.state);
      const checksum = input.checksum ?? checksumState(input.state);
      this.db.sqlite
        .prepare("UPDATE world_state_snapshots SET is_latest = 0, updated_at = ? WHERE user_id = ? AND world_id = ? AND is_latest = 1")
        .run(now, input.userId, input.worldId);
      this.db.sqlite
        .prepare(
          `INSERT INTO world_state_snapshots
            (id, user_id, world_id, tick, snapshot_kind, is_latest, applied_event_sequence, applied_event_ids_json,
             reducer_version, state_json, checksum, created_at, updated_at)
           VALUES
            (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.worldId,
          input.tick,
          input.snapshotKind,
          input.appliedEventSequence,
          JSON.stringify(input.appliedEventIds),
          input.reducerVersion,
          stateJson,
          checksum,
          input.createdAt,
          now,
        );
      return this.getLatest({ userId: input.userId, worldId: input.worldId }) as WorldStateSnapshotRecord;
    })();
    return result;
  }
}

function checksumState(state: WorldRuntimeState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapSnapshot(row: WorldStateSnapshotRow): WorldStateSnapshotRecord {
  const state = parseJson<WorldRuntimeState>(row.state_json, createInitialWorldState(row.updated_at));
  return {
    id: row.id,
    userId: row.user_id,
    worldId: row.world_id,
    tick: row.tick,
    snapshotKind: row.snapshot_kind,
    isLatest: row.is_latest === 1,
    appliedEventSequence: row.applied_event_sequence,
    appliedEventIds: parseJson(row.applied_event_ids_json, []),
    reducerVersion: row.reducer_version,
    state,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Run snapshot repository tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-state-repository.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit state repository**

Run:

```bash
git add ui/src/server/domain/world/world-state-repository.ts ui/src/server/domain/world/world-state-repository.test.ts
git commit -m "feat(world): add snapshot repository"
```

---

### Task 5: Add Deterministic World Reducer

**Files:**
- Create: `ui/src/server/domain/world/world-reducer.ts`
- Create: `ui/src/server/domain/world/world-reducer.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Create `ui/src/server/domain/world/world-reducer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { PUBLIC_VISIBILITY, WorldEventRecord } from "./types";
import { reduceWorldEvents } from "./world-reducer";
import { createInitialWorldSnapshot } from "./world-state-repository";

function event(partial: Partial<WorldEventRecord> & Pick<WorldEventRecord, "id" | "sequence" | "type" | "payload" | "summary">): WorldEventRecord {
  return {
    decisionId: "decision-1",
    worldRunId: "run-1",
    userId: "u001",
    worldId: "default",
    tick: 0,
    schemaVersion: 1,
    reducerVersion: 1,
    visibility: PUBLIC_VISIBILITY,
    actorIds: [],
    locationKey: null,
    causedByEventId: null,
    causedByUserActionId: null,
    idempotencyKey: partial.id,
    status: "committed",
    createdAt: partial.sequence,
    ...partial,
  };
}

describe("reduceWorldEvents", () => {
  it("records applied events without treating observed_only user_action as narrative incident", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "user_action",
          payload: {
            clientActionId: "client-1",
            normalizedMessage: "help",
            targetAgentId: "agent-default",
            interpretationStatus: "observed_only",
            failureReason: "model_failed",
          },
          summary: "user asked for help",
        }),
      ],
    });

    expect(result.worldSnapshot.appliedEventIds).toEqual(["event-1"]);
    expect(result.worldSnapshot.appliedEventSequence).toBe(1);
    expect(result.worldSnapshot.state.tension).toBe(0);
    expect(result.worldSnapshot.state.unresolvedEventIds).toEqual([]);
  });

  it("applies world_incident tension and unresolved event changes", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          payload: {
            title: "港口起火",
            description: "南港仓库在夜里起火。",
            tensionDelta: 0.25,
            stabilityDelta: -0.1,
            unresolved: true,
          },
          summary: "南港仓库起火",
        }),
      ],
    });

    expect(result.worldSnapshot.state.tension).toBe(0.25);
    expect(result.worldSnapshot.state.stability).toBe(0.4);
    expect(result.worldSnapshot.state.unresolvedEventIds).toEqual(["event-1"]);
  });

  it("sorts input events by sequence before reducing", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-2",
          sequence: 2,
          type: "world_incident",
          payload: { title: "second", description: "second", tensionDelta: 0.1 },
          summary: "second",
        }),
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          payload: { title: "first", description: "first", tensionDelta: 0.2 },
          summary: "first",
        }),
      ],
    });

    expect(result.appliedEventIds).toEqual(["event-1", "event-2"]);
    expect(result.worldSnapshot.appliedEventSequence).toBe(2);
    expect(result.worldSnapshot.state.tension).toBe(0.3);
  });
});
```

- [ ] **Step 2: Run the failing reducer tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-reducer.test.ts
```

Expected: fail because `world-reducer.ts` does not exist.

- [ ] **Step 3: Implement `reduceWorldEvents`**

Create `ui/src/server/domain/world/world-reducer.ts`:

```typescript
import type { UserActionPayload, WorldIncidentPayload, WorldReducerInput, WorldReductionResult, WorldRuntimeState } from "./types";

export function reduceWorldEvents(input: WorldReducerInput): WorldReductionResult {
  const ordered = [...input.events]
    .filter((event) => event.status === "committed")
    .sort((a, b) => a.sequence - b.sequence);
  const state: WorldRuntimeState = structuredClone(input.previousSnapshot.state);
  const appliedEventIds = [...input.previousSnapshot.appliedEventIds];
  let appliedEventSequence = input.previousSnapshot.appliedEventSequence;
  const warnings: string[] = [];

  for (const event of ordered) {
    if (event.sequence <= appliedEventSequence) {
      continue;
    }
    if (event.type === "user_action") {
      const payload = event.payload as UserActionPayload;
      if (payload.interpretationStatus === "observed_only") {
        // Audited input only. A later committed event must interpret it before it affects narrative state.
      }
    }
    if (event.type === "world_incident") {
      applyWorldIncident(state, event.id, event.payload as WorldIncidentPayload);
    }
    appliedEventIds.push(event.id);
    appliedEventSequence = event.sequence;
  }

  return {
    appliedEventIds,
    warnings,
    worldSnapshot: {
      ...input.previousSnapshot,
      tick: input.previousSnapshot.tick,
      appliedEventSequence,
      appliedEventIds,
      reducerVersion: input.reducerVersion,
      state,
      updatedAt: Date.now(),
    },
  };
}

function applyWorldIncident(state: WorldRuntimeState, eventId: string, payload: WorldIncidentPayload): void {
  state.tension = clamp01(state.tension + (payload.tensionDelta ?? 0));
  state.stability = clamp01(state.stability + (payload.stabilityDelta ?? 0));
  if (payload.unresolved && !state.unresolvedEventIds.includes(eventId)) {
    state.unresolvedEventIds.push(eventId);
  }
  if (payload.factKey) {
    const exists = state.publicFacts.some((fact) => fact.factKey === payload.factKey);
    if (!exists) {
      state.publicFacts.push({
        factKey: payload.factKey,
        summary: payload.description,
        visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
        sourceEventId: eventId,
      });
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
```

- [ ] **Step 4: Run reducer tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-reducer.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit reducer**

Run:

```bash
git add ui/src/server/domain/world/world-reducer.ts ui/src/server/domain/world/world-reducer.test.ts
git commit -m "feat(world): add deterministic reducer"
```

---

### Task 6: Add Replay Service

**Files:**
- Create: `ui/src/server/domain/world/world-replay-service.ts`
- Create: `ui/src/server/domain/world/world-replay-service.test.ts`

- [ ] **Step 1: Write failing replay tests**

Create `ui/src/server/domain/world/world-replay-service.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { PUBLIC_VISIBILITY } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { rebuildWorldSnapshot } from "./world-replay-service";

describe("rebuildWorldSnapshot", () => {
  it("rebuilds snapshot from committed events in sequence order", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 2,
      type: "world_incident",
      payload: { title: "second", description: "second", tensionDelta: 0.1 },
      summary: "second",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "event-2",
    });
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "world_incident",
      payload: { title: "first", description: "first", tensionDelta: 0.2 },
      summary: "first",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "event-1",
    });

    const rebuilt = rebuildWorldSnapshot({ db, userId: "u001", worldId: "default", now: 1000 });

    expect(rebuilt.appliedEventIds).toEqual(["event-1", "event-2"]);
    expect(rebuilt.appliedEventSequence).toBe(2);
    expect(rebuilt.state.tension).toBe(0.3);
  });
});
```

- [ ] **Step 2: Run the failing replay tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-replay-service.test.ts
```

Expected: fail because `world-replay-service.ts` does not exist.

- [ ] **Step 3: Implement `rebuildWorldSnapshot`**

Create `ui/src/server/domain/world/world-replay-service.ts`:

```typescript
import type { AppDatabase } from "@/server/db/client";
import type { WorldStateSnapshotRecord } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { reduceWorldEvents } from "./world-reducer";
import { createInitialWorldSnapshot } from "./world-state-repository";

export function rebuildWorldSnapshot(input: {
  db: AppDatabase;
  userId: string;
  worldId: string;
  now?: number;
}): WorldStateSnapshotRecord {
  const events = new WorldEventRepository(input.db).listCommitted({
    userId: input.userId,
    worldId: input.worldId,
  });
  const initial = createInitialWorldSnapshot({
    userId: input.userId,
    worldId: input.worldId,
    now: input.now,
  });
  return reduceWorldEvents({
    previousSnapshot: initial,
    events,
    reducerVersion: 1,
  }).worldSnapshot;
}
```

- [ ] **Step 4: Run replay tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-replay-service.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit replay service**

Run:

```bash
git add ui/src/server/domain/world/world-replay-service.ts ui/src/server/domain/world/world-replay-service.test.ts
git commit -m "feat(world): add replay service"
```

---

### Task 7: Phase 1 Verification

**Files:**
- Verify only; no planned file edits.

- [ ] **Step 1: Run Phase 1 targeted tests**

Run:

```bash
cd ui && npm run test:run -- \
  src/server/db/tables-world-phase1.test.ts \
  src/server/domain/world/world-event-repository.test.ts \
  src/server/domain/world/world-state-repository.test.ts \
  src/server/domain/world/world-reducer.test.ts \
  src/server/domain/world/world-replay-service.test.ts
```

Expected: all Phase 1 tests pass.

- [ ] **Step 2: Run all tests**

Run:

```bash
cd ui && npm run test:run
```

Expected: all tests pass.

- [ ] **Step 3: Run production build**

Run:

```bash
cd ui && npm run build
```

Expected: build completes successfully.

- [ ] **Step 4: Check formatting-sensitive diff issues**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit verification adjustments if any were required**

If no edits were required, do not create an empty commit. If fixes were required, commit only those fixes:

```bash
git add ui/src/server/db ui/src/server/domain/world
git commit -m "fix(world): stabilize phase 1 ledger foundation"
```

## Self-Review Checklist

- Phase 1 does not modify `/api/chat`.
- Phase 1 does not add `actor_commands`.
- Phase 1 does not add `WorldMindFlow`.
- Phase 1 does not add model calls or AI SDK structured output.
- Phase 1 replay uses `ORDER BY sequence ASC`.
- Phase 1 snapshots allow same-tick rows by `applied_event_sequence`.
- Phase 1 has targeted tests for tables, event idempotency, reducer behavior, and replay.
