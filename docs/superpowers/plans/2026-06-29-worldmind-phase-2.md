# WorldMind Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable WorldMind core loop behind a feature flag: persisted run envelopes, validated director decisions, one transactional world commit, actor command persistence, and safe chat directive injection.

**Architecture:** Phase 2 extends the Phase 1 event ledger foundation without replacing the existing `Flow<TContext>`. All primary world mutations happen inside one explicit transaction helper used by `WorldMindFlow`; secondary work such as real background ticks and full memory consolidation remains out of scope. The director is injectable for tests, with real structured-output plumbing added but not required for deterministic tests.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, better-sqlite3, Drizzle schema definitions, AI SDK structured output, SQLite.

---

## Phase 2 Scope

Implement:

- `world_runs` persisted retry envelopes.
- `character_states`, `actor_commands`, `world_decision_logs`, and `world_memories` tables.
- Repositories for the new tables.
- `WorldMindDecision` schema, validator, and injectable director generation boundary.
- `WorldMindFlow` with `CommitWorldRunTransaction` as the only primary mutation node.
- `ActorCommandRepository` claim/done/release behavior for `speak_to_user`.
- `ChatContext.worldDirective` and prompt injection using only `actorInstruction`.
- `/api/chat` feature-flag branch for `ENABLE_WORLD_MIND=true`.
- Frontend generation of stable `client_action_id` per outbound user action.

Do not implement in Phase 2:

- Background `world_tick` worker execution.
- Full `WorldMemoryConsolidator` merging strategy.
- Command workers for `move_location`, `investigate`, `remember`, `publish_post`, or `initiate_event`.
- `world_summaries`.
- Real autonomous world scheduling beyond storing `nextTick` in decision logs.

## File Structure

Create:

- `ui/src/server/db/tables-world-phase2.test.ts`  
  Tests new Phase 2 tables, required columns, and indexes.

- `ui/src/server/domain/world/world-run-repository.ts`  
  Creates or returns persisted `WorldRunEnvelope` rows by idempotency key.

- `ui/src/server/domain/world/world-run-repository.test.ts`  
  Tests stable retry envelope behavior.

- `ui/src/server/domain/world/character-state-repository.ts`  
  Loads active actors' state and upserts default/reduced character state.

- `ui/src/server/domain/world/character-state-repository.test.ts`  
  Tests default state, upsert, and active command state.

- `ui/src/server/domain/world/actor-command-repository.ts`  
  Persists actor commands and owns `speak_to_user` claim/done/release lease semantics.

- `ui/src/server/domain/world/actor-command-repository.test.ts`  
  Tests idempotent command insert and claim lifecycle.

- `ui/src/server/domain/world/world-decision-log-repository.ts`  
  Inserts accepted/rejected/model_failed/transaction_failed logs.

- `ui/src/server/domain/world/world-decision-log-repository.test.ts`  
  Tests decision log persistence and best-effort transaction failure logging.

- `ui/src/server/domain/world/world-memory-repository.ts`  
  Stores and recalls world-scoped memory candidates with explicit visibility.

- `ui/src/server/domain/world/world-memory-repository.test.ts`  
  Tests source event requirements and ACL-aware recall.

- `ui/src/server/domain/world/world-decision.ts`  
  Owns `WorldMindDecision`, proposed event, proposed command, memory candidate, command cause, and zod schemas.

- `ui/src/server/domain/world/world-decision-validator.ts`  
  Validates decision shape, event types, command causes, counts, actor membership, and hidden-to-public leakage.

- `ui/src/server/domain/world/world-decision-validator.test.ts`  
  Tests accepted and rejected decision cases.

- `ui/src/server/domain/world/world-context-builder.ts`  
  Builds director context from strict world, snapshot, actors, recent committed events, world memory, and source input.

- `ui/src/server/domain/world/world-context-builder.test.ts`  
  Tests strict world behavior and ACL filtering.

- `ui/src/server/ai/world-director.ts`  
  Uses AI SDK structured output with `purpose: "worldDirector"`.

- `ui/src/server/flow/world-mind-flow.ts`  
  Runs the linear WorldMind nodes and calls the explicit transaction helper.

- `ui/src/server/flow/world-mind-flow.test.ts`  
  Tests accepted, rejected, model_failed, and transaction_failed outcomes.

- `ui/src/server/flow/world-interaction-flow.ts`  
  Performs user input normalization, pre-safety gate, envelope creation, WorldMind run, command claim, ChatFlow run, and command completion.

- `ui/src/server/flow/world-interaction-flow.test.ts`  
  Tests high-risk bypass, missing `client_action_id`, strict world loading, and visible command injection.

Modify:

- `ui/src/server/db/client.ts`  
  Adds Phase 2 runtime SQLite tables and indexes.

- `ui/src/server/db/schema.ts`  
  Adds Drizzle schema definitions for Phase 2 tables.

- `ui/src/server/domain/world/types.ts`  
  Adds run, command, decision, memory, and character state types.

- `ui/src/server/domain/world/world-event-repository.ts`  
  Adds recent ledger queries and transaction-safe helpers where needed.

- `ui/src/server/domain/world/world-reducer.ts`  
  Extends reducer input/output for character states and minimal event types used by Phase 2.

- `ui/src/server/domain/world/world-reducer.test.ts`  
  Adds character state and knowledge reveal reducer tests.

- `ui/src/server/ai/models.ts`  
  Adds `worldDirector` model purpose mapped to `WORLD_DIRECTOR_MODEL`.

- `ui/src/server/ai/chat.test.ts`  
  Adds model purpose fallback tests.

- `ui/src/server/flow/chat-flow.ts`  
  Adds `VisibleActorDirective` to `ChatContext` and prompt injection.

- `ui/src/server/flow/chat-flow.test.ts`  
  Tests directive injection and private reason exclusion.

- `ui/src/app/api/chat/route.ts`  
  Branches to `createWorldInteractionFlow` when `ENABLE_WORLD_MIND=true`.

- Frontend chat sender component file found by `rg "fetch\\(\"/api/chat|/api/chat" ui/src -n`  
  Adds stable `client_action_id` generation per outbound user action.

---

### Task 1: Add Phase 2 Database Tables

**Files:**
- Create: `ui/src/server/db/tables-world-phase2.test.ts`
- Modify: `ui/src/server/db/client.ts`
- Modify: `ui/src/server/db/schema.ts`

- [ ] **Step 1: Write failing table initialization tests**

Create `ui/src/server/db/tables-world-phase2.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "./client";

function columns(db: ReturnType<typeof createTestDatabase>, table: string): string[] {
  return (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function indexNames(db: ReturnType<typeof createTestDatabase>, table: string): string[] {
  return (db.sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((index) => index.name);
}

describe("world phase 2 tables", () => {
  it("creates world_runs as the retry envelope store", () => {
    const db = createTestDatabase();
    expect(columns(db, "world_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "idempotency_key",
        "user_id",
        "world_id",
        "source_type",
        "source_action_id",
        "decision_id",
        "agent_id",
        "status",
        "result_json",
        "created_at",
        "updated_at",
      ]),
    );
    expect(indexNames(db, "world_runs")).toContain("world_runs_idempotency_uidx");
  });

  it("creates character_states with one state per user world actor", () => {
    const db = createTestDatabase();
    expect(columns(db, "character_states")).toEqual(
      expect.arrayContaining([
        "user_id",
        "world_id",
        "agent_id",
        "location_key",
        "current_goal",
        "emotional_state_json",
        "relationship_to_user_json",
        "knowledge_keys_json",
        "active_command_id",
        "last_acted_at",
        "updated_at",
      ]),
    );
    expect(indexNames(db, "character_states")).toContain("character_states_user_world_idx");
  });

  it("creates actor_commands with command claim indexes", () => {
    const db = createTestDatabase();
    expect(columns(db, "actor_commands")).toEqual(
      expect.arrayContaining([
        "id",
        "decision_id",
        "world_run_id",
        "user_id",
        "world_id",
        "target_agent_id",
        "command_type",
        "priority",
        "visibility",
        "visible_to_actor_ids_json",
        "visible_to_user",
        "actor_instruction",
        "private_reason",
        "cause_json",
        "payload_json",
        "related_event_id",
        "status",
        "run_after",
        "expires_at",
        "idempotency_key",
        "claimed_by",
        "claimed_at",
        "claim_expires_at",
        "result_event_id",
        "created_at",
        "updated_at",
      ]),
    );
    expect(indexNames(db, "actor_commands")).toEqual(
      expect.arrayContaining(["actor_commands_idempotency_uidx", "actor_commands_claim_idx", "actor_commands_due_idx"]),
    );
  });

  it("creates world_decision_logs and world_memories", () => {
    const db = createTestDatabase();
    expect(columns(db, "world_decision_logs")).toEqual(
      expect.arrayContaining([
        "decision_id",
        "world_run_id",
        "source_type",
        "validation_status",
        "raw_decision_json",
        "validated_decision_json",
        "created_event_ids_json",
        "created_command_ids_json",
      ]),
    );
    expect(columns(db, "world_memories")).toEqual(
      expect.arrayContaining([
        "subject_type",
        "subject_key",
        "memory_type",
        "canonical_key",
        "content",
        "visibility",
        "source_event_id",
        "source_decision_id",
        "superseded_by",
      ]),
    );
    expect(indexNames(db, "world_memories")).toContain("world_memories_recall_idx");
  });
});
```

- [ ] **Step 2: Run the failing table tests**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase2.test.ts
```

Expected: fail because the Phase 2 tables do not exist.

- [ ] **Step 3: Add runtime SQLite tables and indexes**

In `ui/src/server/db/client.ts`, inside `initializeDatabase(db)` after the Phase 1 world tables, add:

```sql
    -- WorldMind phase 2: retry envelopes
    CREATE TABLE IF NOT EXISTS world_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('user_action', 'scheduled_tick', 'system_trigger')),
      source_action_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'committed', 'failed', 'rejected')),
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS world_runs_idempotency_uidx
      ON world_runs(idempotency_key);
    CREATE INDEX IF NOT EXISTS world_runs_scope_idx
      ON world_runs(user_id, world_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS character_states (
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      location_key TEXT NOT NULL,
      current_goal TEXT NOT NULL,
      emotional_state_json TEXT NOT NULL,
      relationship_to_user_json TEXT NOT NULL,
      knowledge_keys_json TEXT NOT NULL DEFAULT '[]',
      active_command_id TEXT,
      last_acted_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, world_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS character_states_user_world_idx
      ON character_states(user_id, world_id);

    CREATE TABLE IF NOT EXISTS actor_commands (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      world_run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
      visibility TEXT NOT NULL,
      visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      visible_to_user INTEGER NOT NULL DEFAULT 0,
      actor_instruction TEXT NOT NULL,
      private_reason TEXT,
      cause_json TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      related_event_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
      run_after INTEGER NOT NULL,
      expires_at INTEGER,
      idempotency_key TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      claim_expires_at INTEGER,
      result_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS actor_commands_idempotency_uidx
      ON actor_commands(idempotency_key);
    CREATE INDEX IF NOT EXISTS actor_commands_claim_idx
      ON actor_commands(user_id, world_id, target_agent_id, status, priority, run_after);
    CREATE INDEX IF NOT EXISTS actor_commands_due_idx
      ON actor_commands(status, run_after);

    CREATE TABLE IF NOT EXISTS world_decision_logs (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      world_run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_event_id TEXT,
      source_task_id TEXT,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      prompt_context_hash TEXT NOT NULL,
      raw_decision_json TEXT,
      validated_decision_json TEXT,
      validation_status TEXT NOT NULL CHECK (validation_status IN ('accepted', 'rejected', 'model_failed', 'transaction_failed')),
      validation_errors_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_message TEXT,
      created_event_ids_json TEXT NOT NULL DEFAULT '[]',
      created_command_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS world_decision_logs_run_idx
      ON world_decision_logs(world_run_id, created_at);
    CREATE INDEX IF NOT EXISTS world_decision_logs_scope_idx
      ON world_decision_logs(user_id, world_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS world_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      canonical_key TEXT,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL,
      visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      visible_to_user INTEGER NOT NULL DEFAULT 0,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_from_tick INTEGER NOT NULL DEFAULT 0,
      source_event_id TEXT,
      source_decision_id TEXT,
      superseded_by TEXT,
      embedding_json TEXT,
      embedding_quality TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS world_memories_recall_idx
      ON world_memories(user_id, world_id, subject_type, subject_key, memory_type, superseded_by);
```

- [ ] **Step 4: Add Drizzle schema definitions**

In `ui/src/server/db/schema.ts`, add `sqliteTable` definitions mirroring the runtime table columns. Use `text(...).notNull()` for JSON columns and `real(...)` for `importance` and `confidence`.

- [ ] **Step 5: Verify table tests pass**

Run:

```bash
cd ui && npm run test:run -- src/server/db/tables-world-phase2.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/db/client.ts ui/src/server/db/schema.ts ui/src/server/db/tables-world-phase2.test.ts
git commit -m "feat(world): add phase 2 world tables"
```

### Task 2: Add Phase 2 Domain Types

**Files:**
- Modify: `ui/src/server/domain/world/types.ts`

- [ ] **Step 1: Add type compile tests by extending existing usage**

Append these exported types to `ui/src/server/domain/world/types.ts`:

```typescript
export type WorldRunSourceType = "user_action" | "scheduled_tick" | "system_trigger";
export type WorldRunStatus = "running" | "committed" | "failed" | "rejected";

export interface WorldRunEnvelope {
  worldRunId: string;
  decisionId: string;
  sourceType: WorldRunSourceType;
  sourceActionId: string;
  idempotencyKey: string;
  userId: string;
  worldId: string;
  agentId?: string;
  startedAt: number;
}

export interface CharacterStateRecord {
  userId: string;
  worldId: string;
  agentId: string;
  locationKey: string;
  currentGoal: string;
  emotionalState: { label: string; intensity: number };
  relationshipToUser: { affinity: number; trust: number; tension: number };
  knowledgeKeys: string[];
  activeCommandId: string | null;
  lastActedAt: number | null;
  updatedAt: number;
}

export type ActorCommandType =
  | "speak_to_user"
  | "move_location"
  | "investigate"
  | "remember"
  | "publish_post"
  | "initiate_event";
export type ActorCommandPriority = "low" | "normal" | "high";
export type ActorCommandStatus = "pending" | "claimed" | "done" | "failed" | "expired";

export type CommandCause =
  | { type: "proposed_event"; clientEventId: string }
  | { type: "committed_event"; eventId: string }
  | { type: "source_action"; sourceActionId: string }
  | { type: "director_no_event"; reasonCode: string };

export interface ActorCommandRecord {
  id: string;
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  targetAgentId: string;
  commandType: ActorCommandType;
  priority: ActorCommandPriority;
  visibility: VisibilityScope;
  actorInstruction: string;
  privateReason: string | null;
  cause: CommandCause;
  payload: unknown;
  relatedEventId: string | null;
  status: ActorCommandStatus;
  runAfter: number;
  expiresAt: number | null;
  idempotencyKey: string;
  claimedBy: string | null;
  claimedAt: number | null;
  claimExpiresAt: number | null;
  resultEventId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VisibleActorDirective {
  commandId: string;
  actorInstruction: string;
  relatedEventSummary?: string;
}
```

- [ ] **Step 2: Run build to verify type exports**

Run:

```bash
cd ui && npm run build
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add ui/src/server/domain/world/types.ts
git commit -m "feat(world): add phase 2 domain types"
```

### Task 3: Add Run, Character, Command, Decision Log, and Memory Repositories

**Files:**
- Create: `ui/src/server/domain/world/world-run-repository.ts`
- Create: `ui/src/server/domain/world/world-run-repository.test.ts`
- Create: `ui/src/server/domain/world/character-state-repository.ts`
- Create: `ui/src/server/domain/world/character-state-repository.test.ts`
- Create: `ui/src/server/domain/world/actor-command-repository.ts`
- Create: `ui/src/server/domain/world/actor-command-repository.test.ts`
- Create: `ui/src/server/domain/world/world-decision-log-repository.ts`
- Create: `ui/src/server/domain/world/world-decision-log-repository.test.ts`
- Create: `ui/src/server/domain/world/world-memory-repository.ts`
- Create: `ui/src/server/domain/world/world-memory-repository.test.ts`

- [ ] **Step 1: Write `WorldRunRepository` retry tests**

Create `ui/src/server/domain/world/world-run-repository.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldRunRepository } from "./world-run-repository";

describe("WorldRunRepository", () => {
  it("returns the same envelope for the same idempotency key", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const first = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-1",
    });
    const second = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-1",
    });

    expect(second.worldRunId).toBe(first.worldRunId);
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.sourceActionId).toBe("client-1");
  });
});
```

- [ ] **Step 2: Implement `WorldRunRepository`**

Create `ui/src/server/domain/world/world-run-repository.ts` with `createOrGet`, `markCommitted`, `markRejected`, `markFailed`, and `getById`. Use ids `wrun-${randomUUID()}` and `wdec-${randomUUID()}`. On insert unique conflict, return the existing row by `idempotency_key`.

- [ ] **Step 3: Write and implement `CharacterStateRepository`**

Create tests proving `getOrCreateDefault({ userId, worldId, agentId })` returns:

```typescript
{
  locationKey: "default",
  currentGoal: "保持当前互动并等待世界指令",
  emotionalState: { label: "neutral", intensity: 0.35 },
  relationshipToUser: { affinity: 0, trust: 0, tension: 0 },
  knowledgeKeys: [],
  activeCommandId: null,
  lastActedAt: null
}
```

Then implement `getOrCreateDefault`, `listForWorld`, and `upsertMany`.

- [ ] **Step 4: Write and implement `ActorCommandRepository`**

Create tests for:

- `createMany` returns existing command on duplicate `idempotencyKey`.
- `claimVisibleSpeakCommand` only claims pending `speak_to_user` commands visible to the target agent or user.
- claimed commands receive `claimedBy`, `claimedAt`, and `claimExpiresAt`.
- `markDone` prevents reinjection.
- `releaseClaim` returns a command to `pending`.

Implement these methods:

```typescript
createMany(commands: CreateActorCommandInput[]): ActorCommandRecord[]
claimVisibleSpeakCommand(input: { userId: string; worldId: string; agentId: string; claimedBy: string; leaseMs: number }): ActorCommandRecord | null
markDone(input: { commandId: string; resultEventId?: string | null }): ActorCommandRecord | null
releaseClaim(input: { commandId: string; claimedBy: string }): ActorCommandRecord | null
```

Use `ORDER BY priorityWeight DESC, run_after ASC, created_at ASC` in TypeScript by mapping priority to SQL `CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END`.

- [ ] **Step 5: Write and implement `WorldDecisionLogRepository`**

Create tests that insert an accepted log and a transaction_failed log. Implement:

```typescript
insert(input: CreateWorldDecisionLogInput): WorldDecisionLogRecord
listForRun(worldRunId: string): WorldDecisionLogRecord[]
```

The repository must never throw on JSON stringify for arrays; default to `[]`.

- [ ] **Step 6: Write and implement `WorldMemoryRepository`**

Create tests for:

- derived memory with `memoryType !== "lore"` requires `sourceEventId`.
- seed lore memory may omit `sourceEventId`.
- `recallForDirector` can return hidden memory.
- `recallForActor` excludes hidden memory unless the actor id is explicitly listed.

Implement `create`, `recallForDirector`, and `recallForActor`.

- [ ] **Step 7: Run repository tests**

Run:

```bash
cd ui && npm run test:run -- \
  src/server/domain/world/world-run-repository.test.ts \
  src/server/domain/world/character-state-repository.test.ts \
  src/server/domain/world/actor-command-repository.test.ts \
  src/server/domain/world/world-decision-log-repository.test.ts \
  src/server/domain/world/world-memory-repository.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add ui/src/server/domain/world/*repository.ts ui/src/server/domain/world/*repository.test.ts
git commit -m "feat(world): add phase 2 repositories"
```

### Task 4: Add Director Decision Schema, Model Purpose, and Validator

**Files:**
- Create: `ui/src/server/domain/world/world-decision.ts`
- Create: `ui/src/server/domain/world/world-decision-validator.ts`
- Create: `ui/src/server/domain/world/world-decision-validator.test.ts`
- Create: `ui/src/server/ai/world-director.ts`
- Modify: `ui/src/server/ai/models.ts`
- Modify: `ui/src/server/ai/chat.test.ts`

- [ ] **Step 1: Add model purpose test**

In `ui/src/server/ai/chat.test.ts`, add a test near the other model purpose tests:

```typescript
it("uses WORLD_DIRECTOR_MODEL for the world director purpose", async () => {
  await withEnv(
    {
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      CHAT_MODEL: "chat-model-v1",
      WORLD_DIRECTOR_MODEL: "director-model-v1",
    },
    async () => {
      const model = getLanguageModel("worldDirector");
      expect(String(model)).toContain("director-model-v1");
    },
  );
});
```

- [ ] **Step 2: Update model purpose mapping**

In `ui/src/server/ai/models.ts`, change:

```typescript
export type ModelPurpose = "chat" | "memory" | "agentCreator" | "worldCreator" | "feed";
```

to:

```typescript
export type ModelPurpose = "chat" | "memory" | "agentCreator" | "worldCreator" | "feed" | "worldDirector";
```

Add `worldDirector: "WORLD_DIRECTOR_MODEL"` to `purposeEnvKeyByPurpose`.

- [ ] **Step 3: Add decision zod schemas**

Create `ui/src/server/domain/world/world-decision.ts` with zod schemas for:

- `VisibilityScopeSchema`
- `CommandCauseSchema`
- `ProposedWorldEventSchema`
- `ProposedActorCommandSchema`
- `WorldMemoryCandidateSchema`
- `WorldMindDecisionSchema`

Enforce max counts in the schema: observations 6, events 3, commands 5, memories 8, `nextTick.delayMs` between `30_000` and `86_400_000`.

- [ ] **Step 4: Add validator tests**

Create `ui/src/server/domain/world/world-decision-validator.test.ts` with tests for:

- accepted decision with one proposed event and one command referencing that event.
- duplicate `clientEventId` rejected.
- command cause referencing missing proposed event rejected.
- unknown agent id rejected.
- hidden fact in public `actorInstruction` rejected by checking that a hidden event summary string cannot appear in a public command instruction.

- [ ] **Step 5: Implement validator**

Create `ui/src/server/domain/world/world-decision-validator.ts`:

```typescript
export function validateWorldMindDecision(input: {
  decision: WorldMindDecision;
  activeAgentIds: string[];
  hiddenFactSummaries: string[];
}): { ok: true; decision: WorldMindDecision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  // Validate counts, agents, event ids, command causes, and hidden summary leakage.
  return errors.length === 0 ? { ok: true, decision: input.decision } : { ok: false, errors };
}
```

- [ ] **Step 6: Add director generation wrapper**

Create `ui/src/server/ai/world-director.ts`:

```typescript
import { withStructuredOutput } from "./structured-output";
import { WorldMindDecisionSchema, type WorldMindDecision } from "@/server/domain/world/world-decision";

export type GenerateWorldDecision = (input: { system: string; prompt: string }) => Promise<WorldMindDecision>;

export const generateWorldDecision: GenerateWorldDecision = async ({ system, prompt }) => {
  return withStructuredOutput({
    schema: WorldMindDecisionSchema,
    purpose: "worldDirector",
    system,
    prompt,
    temperature: 0.4,
  });
};
```

- [ ] **Step 7: Run tests**

```bash
cd ui && npm run test:run -- src/server/ai/chat.test.ts src/server/domain/world/world-decision-validator.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add ui/src/server/ai/models.ts ui/src/server/ai/chat.test.ts ui/src/server/ai/world-director.ts ui/src/server/domain/world/world-decision.ts ui/src/server/domain/world/world-decision-validator.ts ui/src/server/domain/world/world-decision-validator.test.ts
git commit -m "feat(world): add director decision contract"
```

### Task 5: Extend Reducer for Character State Basics

**Files:**
- Modify: `ui/src/server/domain/world/world-reducer.ts`
- Modify: `ui/src/server/domain/world/world-reducer.test.ts`

- [ ] **Step 1: Add failing reducer tests**

In `world-reducer.test.ts`, add tests proving:

- `knowledge_reveal` adds `factKey` to the target character's `knowledgeKeys`.
- `character_action` with `{ action: "move_location", locationKey: "market" }` updates the character location.
- user_action `observed_only` still only advances applied ids/sequence.

- [ ] **Step 2: Extend reducer input/output**

Update `WorldReducerInput` and `WorldReductionResult` in `types.ts` to include:

```typescript
previousCharacterStates?: CharacterStateRecord[];
characterStates?: CharacterStateRecord[];
```

- [ ] **Step 3: Implement minimal character reducers**

In `world-reducer.ts`, clone `previousCharacterStates ?? []`. For `knowledge_reveal`, add the payload `factKey` to all `event.actorIds` states if absent. For `character_action` move events, update `locationKey` and `lastActedAt`.

- [ ] **Step 4: Run reducer tests**

```bash
cd ui && npm run test:run -- src/server/domain/world/world-reducer.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/server/domain/world/types.ts ui/src/server/domain/world/world-reducer.ts ui/src/server/domain/world/world-reducer.test.ts
git commit -m "feat(world): reduce basic character state events"
```

### Task 6: Build Director Context

**Files:**
- Create: `ui/src/server/domain/world/world-context-builder.ts`
- Create: `ui/src/server/domain/world/world-context-builder.test.ts`
- Modify: `ui/src/server/domain/world/world-event-repository.ts`
- Modify: `ui/src/server/domain/world/world-event-repository.test.ts`

- [ ] **Step 1: Add event repository recent ledger tests**

Add tests for:

- `listRecentForWorld({ limit: 24 })` returns committed events ordered ascending by `sequence`.
- `listRecentForActor({ agentId, limit: 8 })` filters by `actorIds`.

- [ ] **Step 2: Implement recent ledger methods**

In `WorldEventRepository`, implement these methods using `ORDER BY sequence DESC LIMIT ?` in the inner query and reverse results in TypeScript:

```typescript
listRecentForWorld(input: { userId: string; worldId: string; limit: number }): WorldEventRecord[]
listRecentForActor(input: { userId: string; worldId: string; agentId: string; limit: number }): WorldEventRecord[]
```

- [ ] **Step 3: Add context builder tests**

Create `world-context-builder.test.ts` proving:

- missing world id throws instead of falling back to `default`.
- director context includes snapshot state and recent event summaries.
- actor-facing section excludes hidden facts unless actor ACL allows them.

- [ ] **Step 4: Implement context builder**

Create `buildWorldDirectorContext(input)` returning:

```typescript
{
  system: string;
  prompt: string;
  promptContextHash: string;
  hiddenFactSummaries: string[];
  activeAgentIds: string[];
}
```

Hash `system + "\n\n" + prompt` with sha256. Load worlds through `WorldRepository.get(worldId)` only; never fallback to `default`.

- [ ] **Step 5: Run tests**

```bash
cd ui && npm run test:run -- src/server/domain/world/world-event-repository.test.ts src/server/domain/world/world-context-builder.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/domain/world/world-event-repository.ts ui/src/server/domain/world/world-event-repository.test.ts ui/src/server/domain/world/world-context-builder.ts ui/src/server/domain/world/world-context-builder.test.ts
git commit -m "feat(world): build director context"
```

### Task 7: Implement WorldMindFlow Transaction Skeleton

**Files:**
- Create: `ui/src/server/flow/world-mind-flow.ts`
- Create: `ui/src/server/flow/world-mind-flow.test.ts`

- [ ] **Step 1: Write accepted decision transaction test**

Create a test that:

- creates a run envelope for `client-1`.
- injects a fake director returning one `world_incident` and one `speak_to_user` command.
- runs `createWorldMindFlow`.
- asserts one `user_action` event and one derived event share `decisionId` and `worldRunId`.
- asserts latest snapshot applied sequence is 2.
- asserts one pending actor command exists.
- asserts accepted decision log contains created event and command ids.

- [ ] **Step 2: Write rejected and model_failed tests**

Add tests that:

- invalid decision commits only observed_only `user_action`, no command, rejected log.
- director throw commits observed_only `user_action`, no command, model_failed log.

- [ ] **Step 3: Write transaction_failed test**

Make the fake director return two events with duplicate `clientEventId` after validation is bypassed only through a test-only hook, or force command insertion to violate a unique idempotency key. Assert core transaction rolls back and a separate transaction_failed log exists.

- [ ] **Step 4: Implement `createWorldMindFlow`**

Create `ui/src/server/flow/world-mind-flow.ts` with:

```typescript
export interface WorldMindContext {
  db: AppDatabase;
  envelope: WorldRunEnvelope;
  sourceInput?: { message: string; targetAgentId: string };
  generateDecision?: GenerateWorldDecision;
  decision?: WorldMindDecision;
  validationStatus?: "accepted" | "rejected" | "model_failed";
}
```

Nodes:

1. `LoadWorldRunEnvelope`: require `ctx.envelope`.
2. `LoadWorldRuntime`: strict `WorldRepository.get`.
3. `LoadWorldStateSnapshot`: latest or initial in memory.
4. `LoadActiveActors`: active agents in world plus character states.
5. `BuildDirectorContext`.
6. `GenerateDirectorDecision`.
7. `ValidateDirectorDecision`.
8. `CommitWorldRunTransaction`.

Inside `CommitWorldRunTransaction`, use `db.sqlite.transaction(() => { ... })()` and perform event creation, reducer, snapshot save, character state upsert, command insert, decision log insert, and run status update.

- [ ] **Step 5: Run flow tests**

```bash
cd ui && npm run test:run -- src/server/flow/world-mind-flow.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/flow/world-mind-flow.ts ui/src/server/flow/world-mind-flow.test.ts
git commit -m "feat(world): add world mind transaction flow"
```

### Task 8: Add Safe Chat Directive Injection

**Files:**
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/flow/chat-flow.test.ts`

- [ ] **Step 1: Add failing ChatFlow directive tests**

Add tests proving:

- `worldDirective.actorInstruction` appears in the generated prompt.
- `privateReason` cannot be passed because `ChatContext` only accepts `VisibleActorDirective`.
- blocked high-risk chat does not build prompts or inject directives.

- [ ] **Step 2: Update ChatContext**

In `chat-flow.ts`, import `VisibleActorDirective` and add:

```typescript
worldDirective?: VisibleActorDirective | null;
```

to `ChatContext`.

- [ ] **Step 3: Inject directive into prompt**

In `buildSystemPrompt`, append:

```typescript
ctx.worldDirective?.actorInstruction ? `当前世界指令: ${ctx.worldDirective.actorInstruction}` : ""
```

Do not add command id, private reason, raw event payload, or hidden facts.

- [ ] **Step 4: Run ChatFlow tests**

```bash
cd ui && npm run test:run -- src/server/flow/chat-flow.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/server/flow/chat-flow.ts ui/src/server/flow/chat-flow.test.ts
git commit -m "feat(world): inject visible actor directives into chat"
```

### Task 9: Implement WorldInteractionFlow and Chat Route Branch

**Files:**
- Create: `ui/src/server/flow/world-interaction-flow.ts`
- Create: `ui/src/server/flow/world-interaction-flow.test.ts`
- Modify: `ui/src/app/api/chat/route.ts`

- [ ] **Step 1: Write high-risk bypass test**

Test `createWorldInteractionFlow` with high-risk input. Assert:

- no `world_runs` row.
- no `world_events` row.
- no `actor_commands` row.
- returned chat result is the existing safety response shape.

- [ ] **Step 2: Write missing client action id test**

Assert WorldMind mode returns/reports a 400-equivalent error before creating an envelope when `clientActionId` is missing.

- [ ] **Step 3: Write success path test**

Inject fake WorldMind flow or fake director. Assert:

- `clientActionId` maps to `sourceActionId`.
- same retry reuses same `world_run_id`.
- visible `speak_to_user` command is claimed before ChatFlow receives `worldDirective`.
- command is marked done after chat success.

- [ ] **Step 4: Implement `createWorldInteractionFlow`**

Create nodes:

1. `NormalizeUserActionInput`.
2. `PreSafetyCheck`.
3. `RequireClientActionId`.
4. `CreateWorldRunEnvelope`.
5. `RunWorldMind`.
6. `ClaimVisibleSpeakCommand`.
7. `RunChatFlowWithWorldDirective`.
8. `MarkSpeakCommandDone`.
9. `ReturnChatResult`.

Use the same high-risk regex as ChatFlow for Phase 2. Do not call WorldMind for high-risk input.

- [ ] **Step 5: Branch `/api/chat` by feature flag**

In `ui/src/app/api/chat/route.ts`, extend request body type with `client_action_id?: string`. If `process.env.ENABLE_WORLD_MIND === "true"`, require `client_action_id` and use `createWorldInteractionFlow`; otherwise keep existing `createChatFlow` path and `domain_id || "default"` fallback.

- [ ] **Step 6: Run tests**

```bash
cd ui && npm run test:run -- src/server/flow/world-interaction-flow.test.ts src/server/flow/chat-flow.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/server/flow/world-interaction-flow.ts ui/src/server/flow/world-interaction-flow.test.ts ui/src/app/api/chat/route.ts
git commit -m "feat(world): route chat through world interaction flow"
```

### Task 10: Add Frontend Client Action Id

**Files:**
- Modify: frontend chat sender file found by `rg "/api/chat|client_action_id" ui/src -n`
- Add or modify matching frontend test if one exists.

- [ ] **Step 1: Locate the chat sender**

Run:

```bash
rg "/api/chat|client_action_id" ui/src -n
```

Expected: identify the component or hook that posts chat messages.

- [ ] **Step 2: Add stable id per outbound message**

Before sending the request, create:

```typescript
const clientActionId = crypto.randomUUID();
```

Include it in the request body:

```typescript
client_action_id: clientActionId,
```

Do not regenerate it inside retry logic for the same outbound message. If the sender has explicit retry state, store `clientActionId` with the pending message object.

- [ ] **Step 3: Run frontend tests or build**

If a frontend test exists for the sender, run it. Otherwise run:

```bash
cd ui && npm run build
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src
git commit -m "feat(world): send client action ids from chat"
```

### Task 11: Phase 2 Verification Pass

**Files:**
- No production files unless failures reveal a defect.

- [ ] **Step 1: Run all world-focused tests**

```bash
cd ui && npm run test:run -- \
  src/server/db/tables-world-phase1.test.ts \
  src/server/db/tables-world-phase2.test.ts \
  src/server/domain/world/world-event-repository.test.ts \
  src/server/domain/world/world-state-repository.test.ts \
  src/server/domain/world/world-reducer.test.ts \
  src/server/domain/world/world-replay-service.test.ts \
  src/server/domain/world/world-run-repository.test.ts \
  src/server/domain/world/character-state-repository.test.ts \
  src/server/domain/world/actor-command-repository.test.ts \
  src/server/domain/world/world-decision-log-repository.test.ts \
  src/server/domain/world/world-memory-repository.test.ts \
  src/server/domain/world/world-decision-validator.test.ts \
  src/server/domain/world/world-context-builder.test.ts \
  src/server/flow/world-mind-flow.test.ts \
  src/server/flow/world-interaction-flow.test.ts
```

Expected: pass.

- [ ] **Step 2: Run full test suite**

```bash
cd ui && npm run test:run
```

Expected: pass.

- [ ] **Step 3: Run production build**

```bash
cd ui && npm run build
```

Expected: pass.

- [ ] **Step 4: Run diff hygiene**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional files changed or clean after commits.

- [ ] **Step 5: Handle any final fixes**

If verification fails, return to the task that introduced the failing behavior, add a failing regression test there, fix it, rerun that task's verification command, then rerun this full Phase 2 verification pass. If no fixes were needed, do not create an empty commit.

---

## Phase 2 Acceptance Criteria

- With `ENABLE_WORLD_MIND=false`, `/api/chat` keeps current behavior and may fallback to `default`.
- With `ENABLE_WORLD_MIND=true`, `/api/chat` requires `client_action_id` and strict world loading.
- Legal user input creates or reuses one `world_runs` envelope by idempotency key.
- Accepted director output commits source and derived events, latest snapshot, character state updates, actor commands, and accepted decision log in one SQLite transaction.
- Rejected user actions commit only observed-only `user_action` plus `validationStatus = "rejected"` decision log; model-failed user actions commit only observed-only `user_action` plus `validationStatus = "model_failed"` decision log.
- Transaction failure rolls back primary state and writes a separate best-effort `transaction_failed` log.
- `speak_to_user` commands are claimed before prompt injection and marked done only after chat success.
- Chat prompts receive only `VisibleActorDirective.actorInstruction`, never raw `ActorCommand.privateReason`.
- Hidden facts and hidden memories do not appear in actor-visible context unless explicit ACL allows it.
