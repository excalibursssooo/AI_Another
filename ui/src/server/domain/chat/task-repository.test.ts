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

  it("claimNext skips rows with run_after > now", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    tasks.enqueue({ kind: "memory_extract", payload: { x: 1 }, runAfter: oneHourFromNow });
    expect(tasks.claimNext()).toBeNull();
  });

  it("markFailed increments attempts, records last_error, and schedules a retry", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const enqueued = tasks.enqueue({ kind: "memory_extract", payload: { foo: 1 } });
    const errorMessage = "boom: something exploded";
    const failed = tasks.markFailed(enqueued.id, errorMessage);
    expect(failed).not.toBeNull();
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain("boom");
    expect(failed?.nextAttemptAt).toBeGreaterThan(Date.now());

    const reread = tasks.get(enqueued.id);
    expect(reread?.attempts).toBe(1);
    expect(reread?.lastError).toContain("boom");
  });

  it("enqueue with runAfter in the past is immediately claimable; runAfter in the future is not", () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const oneMinuteAgo = Date.now() - 60 * 1000;
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    const pastTask = tasks.enqueue({ kind: "memory_extract", payload: { when: "past" }, runAfter: oneMinuteAgo });
    const futureTask = tasks.enqueue({ kind: "memory_extract", payload: { when: "future" }, runAfter: oneHourFromNow });

    const firstClaim = tasks.claimNext();
    expect(firstClaim).not.toBeNull();
    expect(firstClaim?.id).toBe(pastTask.id);
    expect(firstClaim?.status).toBe("running");

    const secondClaim = tasks.claimNext();
    expect(secondClaim).toBeNull();

    const verifiedPast = tasks.get(pastTask.id);
    expect(verifiedPast?.status).toBe("running");
    expect(verifiedPast?.id).toBe(pastTask.id);

    void futureTask;
  });
});
