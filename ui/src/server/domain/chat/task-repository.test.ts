import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "./task-repository";

describe("TaskRepository", () => {
  it("enqueue returns a TaskRecord with id starting with 'task-'", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const record = tasks.enqueue({ kind: "memory_extract", payload: { foo: 1 } });
    expect(record.id).toMatch(/^task-/);
  });

  it("claimNext returns null when no tasks are pending", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    expect(tasks.claimNext()).toBeNull();
  });

  it("markDone sets status to 'done'", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    // First enqueue a task so we have a valid id to mark done
    const enqueued = tasks.enqueue({ kind: "memory_extract", payload: { foo: 1 } });
    const result = tasks.markDone(enqueued.id);
    expect(result?.status).toBe("done");
  });
});
