import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "./task-repository";

describe("TaskRepository lease behavior", () => {
  it("returns the existing task for duplicate idempotency keys", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const first = tasks.enqueue({
      kind: "world_tick",
      payload: { worldId: "default" },
      idempotencyKey: "tick:default:1",
    });
    const second = tasks.enqueue({
      kind: "world_tick",
      payload: { worldId: "default", ignored: true },
      idempotencyKey: "tick:default:1",
    });
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ worldId: "default" });
  });

  it("claims a due task with a worker lease and does not claim it again before expiry", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" } });
    const claimed = tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockedBy).toBe("worker-a");
    expect(tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-b", leaseMs: 30_000 })).toBeNull();
  });

  it("reclaims a running task after the lock expires", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" } });
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 1 });
    db.sqlite.prepare("UPDATE tasks SET lock_expires_at = ? WHERE id = ?").run(Date.now() - 1_000, task.id);
    const reclaimed = tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-b", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(task.id);
    expect(reclaimed?.lockedBy).toBe("worker-b");
  });

  it("retries failed tasks with bounded backoff before permanent failure", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({ kind: "world_tick", payload: { worldId: "default" }, maxAttempts: 2 });
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    const firstFailure = tasks.markFailed(task.id, "first failure");
    expect(firstFailure?.status).toBe("pending");
    expect(firstFailure?.attempts).toBe(1);
    expect(firstFailure?.nextAttemptAt).toBeGreaterThan(Date.now());

    db.sqlite.prepare("UPDATE tasks SET next_attempt_at = ? WHERE id = ?").run(Date.now() - 1, task.id);
    tasks.claimNext({ kinds: ["world_tick"], workerId: "worker-a", leaseMs: 30_000 });
    const permanent = tasks.markFailed(task.id, "second failure");
    expect(permanent?.status).toBe("failed");
    expect(permanent?.attempts).toBe(2);
    expect(permanent?.failedPermanentlyAt).not.toBeNull();
  });
});
