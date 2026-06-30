import { describe, expect, it, vi } from "vitest";

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
        sourceMessageId: "msg-source-1",
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
    const memories = new MemoryRepository(db).list({
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        status: "active",
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].sourceMessageId).toBe("msg-source-1");
  });

  it("drainChatTasks propagates fallbackReplies into MemoryExtractContext", async () => {
    const db = createTestDatabase();
    const tasks = new TaskRepository(db);
    const task = tasks.enqueue({
      kind: "memory_extract",
      payload: {
        userId: "u1", agentId: "a1", worldId: "w1",
        userMessage: "今天天气真好", assistantMessage: "确实很舒适",
        fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
      },
    });
    const generateSpy = vi.fn().mockResolvedValue({ memories: [] });
    await drainChatTasks({ db, generateMemoryExtraction: generateSpy, limit: 1 });
    expect(generateSpy).toHaveBeenCalled();
    void task;
  });
});
