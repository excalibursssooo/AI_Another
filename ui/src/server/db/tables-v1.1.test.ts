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
