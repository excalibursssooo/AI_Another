import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { drainChatTasks } from "./task-worker";

describe("drainChatTasks", () => {
  it("claims pending memory extraction tasks and persists extracted memories", async () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({
      kind: "memory_extract",
      payload: {
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        userMessage: "请记住我喜欢雨天散步",
        assistantMessage: "我会记住。",
      },
    });

    const result = await drainChatTasks({
      db,
      limit: 1,
      generateMemoryExtraction: async () => ({
        memories: [
          {
            subject: "user",
            type: "preference",
            content: "用户喜欢雨天散步",
            importance: 0.8,
            confidence: 0.9,
          },
        ],
      }),
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(tasks.get(task.id)?.status).toBe("done");
    expect(
      new MemoryRepository(db).list({
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        status: "active",
      }),
    ).toHaveLength(1);
  });
});
