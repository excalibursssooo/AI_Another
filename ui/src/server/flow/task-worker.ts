import type { AppDatabase } from "@/server/db/client";
import type { GenerateMemoryExtraction } from "@/server/ai/chat";
import { TaskRepository } from "@/server/domain/chat/task-repository";

import { createMemoryExtractFlow } from "./memory-extract-flow";

export interface DrainChatTasksResult {
  processed: number;
  failed: number;
}

export async function drainChatTasks(options: {
  db: AppDatabase;
  limit?: number;
  generateMemoryExtraction?: GenerateMemoryExtraction;
}): Promise<DrainChatTasksResult> {
  const tasks = new TaskRepository(options.db);
  const limit = Math.max(0, options.limit ?? 3);
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const task = tasks.claimNext({
      kinds: ["memory_extract"],
      workerId: "chat-task-worker",
      leaseMs: 60_000,
    });
    if (!task) {
      break;
    }

    try {
      const payload = parseMemoryExtractPayload(task.payload);
      await createMemoryExtractFlow({
        db: options.db,
        generateMemoryExtraction: options.generateMemoryExtraction,
      }).run({ ...payload, sourceTaskId: task.id });
      tasks.markDone(task.id);
      processed += 1;
    } catch (error) {
      tasks.markFailed(task.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }

  return { processed, failed };
}

function parseMemoryExtractPayload(payload: unknown): {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  sourceMessageId?: string | null;
  agentName?: string;
  fallbackReplies?: string[];
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid memory_extract payload");
  }
  const record = payload as Record<string, unknown>;
  const userId = readRequiredString(record, "userId");
  const agentId = readRequiredString(record, "agentId");
  const worldId = readRequiredString(record, "worldId");
  const userMessage = readRequiredString(record, "userMessage");
  const assistantMessage = readRequiredString(record, "assistantMessage");
  const sourceMessageId =
    typeof record.sourceMessageId === "string" && record.sourceMessageId.trim()
      ? record.sourceMessageId
      : null;
  const agentName = typeof record.agentName === "string" ? record.agentName : undefined;
  const fallbackReplies = Array.isArray(record.fallbackReplies)
    ? record.fallbackReplies.filter((x): x is string => typeof x === "string")
    : undefined;
  return { userId, agentId, worldId, userMessage, assistantMessage, sourceMessageId, agentName, fallbackReplies };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid memory_extract payload: ${key}`);
  }
  return value;
}
