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
