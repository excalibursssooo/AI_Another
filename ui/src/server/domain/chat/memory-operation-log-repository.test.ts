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
    expect(row.detail).toEqual({ checked: 10, reasons: { hypothetical_context: 4 } });
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
