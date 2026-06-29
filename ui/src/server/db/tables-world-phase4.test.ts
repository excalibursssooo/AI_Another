import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, createTestDatabase } from "./client";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function columns(table: string): string[] {
  const db = createTestDatabase();
  return (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function indexes(table: string): string[] {
  const db = createTestDatabase();
  return (db.sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((index) => index.name);
}

function legacyDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "another-world-db-"));
  tempDirs.push(dir);
  return path.join(dir, "legacy.sqlite");
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

  it("migrates existing task tables before creating lease indexes", () => {
    const filename = legacyDatabasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const db = createDatabase(filename);
    const taskColumns = (db.sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const taskIndexes = (db.sqlite.prepare("PRAGMA index_list(tasks)").all() as Array<{ name: string }>).map(
      (index) => index.name,
    );

    expect(taskColumns).toEqual(expect.arrayContaining(["idempotency_key", "next_attempt_at", "lock_expires_at"]));
    expect(taskIndexes).toEqual(expect.arrayContaining(["tasks_idempotency_uidx", "tasks_claim_idx"]));
    db.sqlite.close();
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
