import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { drainWorldTickTasks } from "./world-tick-worker";

describe("drainWorldTickTasks", () => {
  it("claims a world_tick task, creates a scheduled_tick envelope, runs WorldMind, and marks the task done", async () => {
    const db = createTestDatabase();
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({
      kind: "world_tick",
      payload: { userId: "u001", worldId: "default", reason: "test tick", scheduledTick: Date.now() },
      idempotencyKey: "tick:u001:default:1",
    });

    const result = await drainWorldTickTasks({
      db,
      limit: 1,
      workerId: "tick-worker",
      createWorldMind: async () => ({
        validationStatus: "accepted",
        decisionLogId: "log-1",
        createdEventIds: [],
        createdCommandIds: [],
        proposedEventIdToCommittedEventId: {},
      }),
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(tasks.get(task.id)?.status).toBe("done");
    const run = new WorldRunRepository(db).getByIdempotencyKey("world_tick:tick:u001:default:1");
    expect(run?.sourceType).toBe("scheduled_tick");
    expect(run?.sourceActionId).toBe(task.id);
  });

  it("marks invalid tick payloads failed and retryable", async () => {
    const db = createTestDatabase();
    const task = new TaskRepository(db).enqueue({ kind: "world_tick", payload: { userId: "u001" }, maxAttempts: 2 });

    const result = await drainWorldTickTasks({ db, limit: 1, workerId: "tick-worker" });

    expect(result.failed).toBe(1);
    expect(new TaskRepository(db).get(task.id)?.status).toBe("pending");
  });
});
