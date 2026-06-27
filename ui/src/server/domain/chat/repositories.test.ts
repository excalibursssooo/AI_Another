import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import {
  AgentRepository,
  AgentLiveStateRepository,
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

  it("recall: orders by importance when query is empty (FTS5 + multi-factor)", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);

    const objects = db.sqlite
      .prepare("SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?)")
      .all("memories_fts", "memories_ai", "memories_ad", "memories_au", "memories") as Array<{
      name: string;
      type: string;
    }>;
    const names = objects.map((o) => `${o.type}:${o.name}`);
    expect(names).toContain("table:memories_fts");
    expect(names).toContain("trigger:memories_ai");
    expect(names).toContain("trigger:memories_ad");
    expect(names).toContain("trigger:memories_au");

    const low = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户偶尔喝咖啡",
      importance: 0.1,
      confidence: 0.5,
    });
    const mid = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢周末骑行",
      importance: 0.5,
      confidence: 0.5,
    });
    const high = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户对花生过敏",
      importance: 0.9,
      confidence: 0.5,
    });

    const recalled = memories.recall({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      query: "",
      limit: 5,
    });

    expect(recalled).toHaveLength(3);
    expect(recalled[0].id).toBe(high.id);
    expect(recalled.map((r) => r.id)).toContain(mid.id);
    expect(recalled.map((r) => r.id)).toContain(low.id);
  });

  it("recall: uses FTS5 prefix match for partial query", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);

    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "雨天散步让用户感到放松",
      importance: 0.7,
      confidence: 0.8,
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

  it("recall: uses FTS5 for wildcard prefix queries and records access", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);

    const created = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "The user prefers rainy walks.",
      importance: 0.7,
      confidence: 0.8,
    });

    const recalled = memories.recall({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      query: "rain*",
      limit: 5,
    });

    expect(recalled.map((item) => item.id)).toEqual([created.id]);
    const [stored] = memories.list({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      status: "active",
    });
    expect(stored.accessCount).toBe(1);
    expect(stored.lastAccessedAt).toEqual(expect.any(Number));
  });

  it("recall: multi-factor score weights importance above recency", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const DAY = 86_400_000;
    const now = Date.now();

    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢散步",
      importance: 0.5,
      confidence: 0.5,
    });
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户散步时思考工作",
      importance: 0.95,
      confidence: 0.5,
    });
    const fresh = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户散步时常听播客",
      importance: 0.1,
      confidence: 0.5,
    });

    db.sqlite
      .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
      .run(now - 30 * DAY, old.id);

    const recalled = memories.recall({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      query: "散步",
      limit: 5,
    });

    const ids = recalled.map((r) => r.id);
    expect(recalled).toHaveLength(3);
    expect(ids.indexOf(old.id)).toBeLessThan(ids.indexOf(fresh.id));
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

  it("stores live state independently per user for the same agent", () => {
    const db = createTestDatabase();
    const liveStates = new AgentLiveStateRepository(db);

    liveStates.upsert({
      userId: "u001",
      agentId: "agent-default",
      agentName: "小伴",
      moodLabel: "calm",
      moodIntensity: 0.2,
      heartbeatBpm: 70,
      riskLevel: "low",
      updatedAt: 1000,
    });
    liveStates.upsert({
      userId: "u002",
      agentId: "agent-default",
      agentName: "小伴",
      moodLabel: "alert",
      moodIntensity: 0.8,
      heartbeatBpm: 92,
      riskLevel: "medium",
      updatedAt: 2000,
    });

    expect(liveStates.get("u001", "agent-default", "fallback")).toMatchObject({
      userId: "u001",
      moodLabel: "calm",
      heartbeatBpm: 70,
    });
    expect(liveStates.get("u002", "agent-default", "fallback")).toMatchObject({
      userId: "u002",
      moodLabel: "alert",
      heartbeatBpm: 92,
    });
  });
});

describe("memory embedding schema", () => {
  it("initializes memory embedding and supersession columns", () => {
    const db = createTestDatabase();
    const columns = db.sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    for (const name of [
      "canonical_key",
      "topic",
      "embedding_json",
      "embedding_model",
      "embedding_backend",
      "embedding_quality",
      "embedding_dimension",
      "embedding_status",
      "embedding_text_hash",
      "embedding_version",
      "embedding_needs_refresh",
      "embedding_updated_at",
      "superseded_by",
      "superseded_reason",
      "last_observed_at",
      "source_message_id",
      "source_task_id",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe("MemoryRepository embedding metadata", () => {
  it("creates and reads embedding metadata", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);

    const created = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.weather.rain",
      topic: "rain",
      content: "用户喜欢雨天散步。",
      importance: 0.8,
      confidence: 0.9,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "hash-a",
        version: 1,
        needsRefresh: false,
        updatedAt: 123,
      },
      sourceTaskId: "task-1",
    });

    const [read] = memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" });
    expect(read.id).toBe(created.id);
    expect(read.key).toBe("preference.weather.rain");
    expect(read.topic).toBe("rain");
    expect(read.embeddingStatus).toBe("ready");
    expect(read.embeddingJson).toBe(JSON.stringify([1, 0]));
    expect(read.sourceTaskId).toBe("task-1");
  });

  it("atomically replaces a conflicting memory", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢咖啡。",
      importance: 0.6,
      confidence: 0.8,
    });

    const replacement = memories.replaceConflicted({
      oldMemoryId: old.id,
      reason: "preference reversal",
      newMemory: {
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        subject: "user",
        memoryType: "preference",
        content: "用户不喜欢咖啡。",
        importance: 0.9,
        confidence: 0.95,
      },
    });

    const rows = memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "all" });
    const frozen = rows.find((item) => item.id === old.id);
    expect(frozen?.status).toBe("frozen");
    expect(frozen?.supersededBy).toBe(replacement.id);
    expect(replacement.status).toBe("active");
  });

  it("merges an active memory with refreshed metadata", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢本地小模型。",
      importance: 0.5,
      confidence: 0.7,
    });

    const merged = memories.mergeMemory({
      memoryId: old.id,
      content: "用户偏好本地小模型，尤其是 10B 以下、能端侧 JSON 输出的模型。",
      importance: 0.9,
      confidence: 0.85,
      embedding: {
        json: JSON.stringify([0.5, 0.5]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "hash-b",
        version: 1,
        needsRefresh: false,
        updatedAt: 456,
      },
      lastObservedAt: 456,
    });

    expect(merged?.content).toContain("10B 以下");
    expect(merged?.importance).toBe(0.9);
    expect(merged?.embeddingStatus).toBe("ready");
  });
});
