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
