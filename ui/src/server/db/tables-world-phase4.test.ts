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
    expect(indexes("tasks")).toEqual(expect.arrayContaining(["tasks_idempotency_uidx", "tasks_claim_idx"]));
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
