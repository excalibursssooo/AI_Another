import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { createChatFlow } from "./chat-flow";

describe("ChatFlow", () => {
  it("persists user and assistant messages and returns done-compatible data", async () => {
    const db = createTestDatabase();
    const flow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "我在这里。",
        mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
    });

    expect(result.reply).toBe("我在这里。");
    expect(result.doneEvent?.agent_id).toBe("agent-default");
    expect(result.doneEvent?.persisted_memory_count).toBeGreaterThanOrEqual(0);
    expect(result.recentMessages?.map((item) => item.content)).toEqual(["你好", "我在这里。"]);
  });

  it("blocks high risk input before model generation", async () => {
    const db = createTestDatabase();
    let called = false;
    const flow = createChatFlow({
      db,
      generateChatReply: async () => {
        called = true;
        throw new Error("should not call model");
      },
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "我要自杀",
    });

    expect(called).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.reply).toContain("我在这里");
  });

  it("queues memory extraction after returning the chat result", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const flow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "我会记住。",
        mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "请记住我喜欢雨天散步",
    });

    expect(result.doneEvent?.persisted_memory_count).toBe(0);
    expect(memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "active" })).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "active" })).toHaveLength(1);
  });
});
