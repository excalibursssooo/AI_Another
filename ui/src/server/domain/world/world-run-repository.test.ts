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

  it("marks a run as committed with result", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const envelope = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-2",
    });

    const committed = runs.markCommitted({ worldRunId: envelope.worldRunId, result: { tick: 42, summary: "done" } });
    expect(committed).not.toBeNull();
    expect(committed!.status).toBe("committed");
    expect(committed!.resultJson).toBe('{"tick":42,"summary":"done"}');
  });

  it("marks a run as rejected", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const envelope = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-3",
    });

    const rejected = runs.markRejected({ worldRunId: envelope.worldRunId });
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
  });

  it("marks a run as failed", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const envelope = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-4",
    });

    const failed = runs.markFailed({ worldRunId: envelope.worldRunId });
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
  });

  it("getById returns the run", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const envelope = runs.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-5",
    });

    const found = runs.getById(envelope.worldRunId);
    expect(found).not.toBeNull();
    expect(found!.worldRunId).toBe(envelope.worldRunId);
  });

  it("getById returns null for unknown id", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const found = runs.getById("wrun-unknown");
    expect(found).toBeNull();
  });

  it("markCommitted returns null for unknown id", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const result = runs.markCommitted({ worldRunId: "wrun-unknown" });
    expect(result).toBeNull();
  });

  it("markRejected returns null for unknown id", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const result = runs.markRejected({ worldRunId: "wrun-unknown" });
    expect(result).toBeNull();
  });

  it("markFailed returns null for unknown id", () => {
    const runs = new WorldRunRepository(createTestDatabase());
    const result = runs.markFailed({ worldRunId: "wrun-unknown" });
    expect(result).toBeNull();
  });
});
