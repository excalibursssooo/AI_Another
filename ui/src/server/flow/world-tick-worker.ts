import type { AppDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";

import type { WorldMindContext, WorldMindResult } from "./world-mind-flow";
import { createWorldMindFlow } from "./world-mind-flow";

export interface DrainWorldTickTasksResult {
  processed: number;
  failed: number;
}

export async function drainWorldTickTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
  createWorldMind?: (ctx: WorldMindContext) => Promise<WorldMindResult>;
}): Promise<DrainWorldTickTasksResult> {
  const tasks = new TaskRepository(options.db);
  const limit = Math.max(0, options.limit ?? 3);
  const workerId = options.workerId ?? "world-tick-worker";
  const runWorldMind = options.createWorldMind ?? createWorldMindFlow;
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const task = tasks.claimNext({ kinds: ["world_tick"], workerId, leaseMs: 60_000 });
    if (!task) {
      break;
    }

    try {
      const payload = parseWorldTickPayload(task.payload);
      const envelope = new WorldRunRepository(options.db).createOrGet({
        userId: payload.userId,
        worldId: payload.worldId,
        sourceType: "scheduled_tick",
        sourceActionId: task.id,
        idempotencyKey: `world_tick:${task.idempotencyKey ?? task.id}`,
      });
      await runWorldMind({
        db: options.db,
        envelope,
        sourceTaskId: task.id,
        sourceInput: { message: payload.reason, targetAgentId: "" },
      });
      tasks.markDone(task.id);
      processed += 1;
    } catch (error) {
      tasks.markFailed(task.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }

  return { processed, failed };
}

function parseWorldTickPayload(payload: unknown): {
  userId: string;
  worldId: string;
  reason: string;
  scheduledTick: number;
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid world_tick payload");
  }
  const record = payload as Record<string, unknown>;
  return {
    userId: readRequiredString(record, "userId"),
    worldId: readRequiredString(record, "worldId"),
    reason: readRequiredString(record, "reason"),
    scheduledTick: readRequiredNumber(record, "scheduledTick"),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid world_tick payload: ${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid world_tick payload: ${key}`);
  }
  return value;
}
