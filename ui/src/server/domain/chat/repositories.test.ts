import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import {
  AgentRepository,
  ConversationRepository,
  FeedPostRepository,
  MemoryRepository,
  WorldRepository,
} from "./repositories";

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

  it("creates updates and deactivates agents", () => {
    const db = createTestDatabase();
    const agents = new AgentRepository(db);

    const created = agents.create({
      name: "lin",
      displayName: "林",
      persona: "冷静、专注",
      background: "由测试创建",
      greeting: "你好，我是林。",
      speakingStyle: "简洁",
      hobbies: ["阅读"],
      worldId: "default",
    });
    const updated = agents.update(created.id, { persona: "冷静、可靠", hobbies: ["阅读", "跑步"] });
    const deleted = agents.deactivate(created.id);

    expect(created.id).toMatch(/^agent-/);
    expect(updated?.persona).toBe("冷静、可靠");
    expect(updated?.hobbies).toEqual(["阅读", "跑步"]);
    expect(deleted?.status).toBe("inactive");
    expect(agents.listActive("default").some((item) => item.id === created.id)).toBe(false);
  });

  it("creates and updates worlds", () => {
    const db = createTestDatabase();
    const worlds = new WorldRepository(db);

    const created = worlds.upsert({
      id: "city-night",
      name: "夜城",
      lore: "霓虹雨夜中的城市。",
      tone: "克制、温柔",
      constraints: ["不要打破世界观"],
      seedMemories: ["用户喜欢雨夜"],
    });
    const updated = worlds.upsert({ ...created, tone: "安静、温柔" });

    expect(created.id).toBe("city-night");
    expect(updated.tone).toBe("安静、温柔");
    expect(worlds.get("city-night")?.seedMemories).toEqual(["用户喜欢雨夜"]);
  });

  it("updates memory status without losing scope checks", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const created = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢安静的咖啡馆",
      importance: 0.7,
      confidence: 0.8,
    });

    expect(
      memories.setStatus({
        userId: "other",
        agentId: "agent-default",
        worldId: "default",
        memoryId: created.id,
        status: "frozen",
      }),
    ).toBeNull();
    expect(
      memories.setStatus({
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        memoryId: created.id,
        status: "frozen",
      })?.status,
    ).toBe("frozen");
  });

  it("stores feed posts and lists them by user and world", () => {
    const db = createTestDatabase();
    const posts = new FeedPostRepository(db);

    const created = posts.create({
      userId: "u001",
      agentId: "agent-default",
      agentName: "小伴",
      worldId: "default",
      content: "今天想把那些没说完的话整理好。",
      topicSeed: "整理没说完的话",
      postType: "reflection",
      sourceTaskId: null,
      status: "published",
    });

    expect(created.id).toMatch(/^post-/);
    expect(posts.list({ userId: "u001", worldId: "default", limit: 20, offset: 0, includeArchived: false }).items).toHaveLength(1);
    expect(posts.get(created.id)?.topicSeed).toBe("整理没说完的话");
  });
});
