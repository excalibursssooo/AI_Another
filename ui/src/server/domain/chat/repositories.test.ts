import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { AgentRepository, ConversationRepository, MemoryRepository, WorldRepository } from "./repositories";

describe("chat repositories", () => {
  it("seeds defaults and persists conversation turns", () => {
    const db = createTestDatabase();
    const agents = new AgentRepository(db);
    const worlds = new WorldRepository(db);
    const conversations = new ConversationRepository(db);

    expect(agents.listActive("default")).toHaveLength(1);
    expect(worlds.list()).toHaveLength(1);

    const conversationId = conversations.ensureConversation({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });
    conversations.appendMessage({ conversationId, role: "user", content: "hello" });
    conversations.appendMessage({ conversationId, role: "assistant", content: "hi" });

    expect(conversations.recentMessages(conversationId, 5).map((item) => item.content)).toEqual(["hello", "hi"]);
  });

  it("stores and recalls active memories for an agent", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    });

    const recalled = memories.recall({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      query: "雨天",
      limit: 5,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toContain("雨天");
  });
});
