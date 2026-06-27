import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { createMemoryExtractFlow } from "./memory-extract-flow";

describe("MemoryExtractFlow", () => {
  it("extracts and persists structured memory candidates from a message pair", async () => {
    const db = createTestDatabase();
    const flow = createMemoryExtractFlow({
      db,
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

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      userMessage: "我喜欢雨天散步",
      assistantMessage: "我记住了。",
    });

    expect(result.persistedMemoryCount).toBe(1);
    const memories = new MemoryRepository(db).list({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      status: "active",
    });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    });
  });

  it("persists at most eight non-empty candidates", async () => {
    const db = createTestDatabase();
    const flow = createMemoryExtractFlow({
      db,
      generateMemoryExtraction: async () => ({
        memories: [
          {
            subject: "user",
            type: "profile",
            content: "   ",
            importance: 0.2,
            confidence: 0.2,
          },
          ...Array.from({ length: 10 }, (_, index) => ({
            subject: "user" as const,
            type: "event" as const,
            content: `候选记忆 ${index + 1}`,
            importance: 0.5,
            confidence: 0.6,
          })),
        ],
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      userMessage: "今天发生了很多事",
      assistantMessage: "我听到了。",
    });

    expect(result.persistedMemoryCount).toBe(8);
    expect(
      new MemoryRepository(db).list({
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        status: "active",
      }),
    ).toHaveLength(8);
  });

  it("consolidates extracted candidates instead of direct inserting duplicates", async () => {
    const db = createTestDatabase();
    const flow = createMemoryExtractFlow({
      db,
      generateMemoryExtraction: async () => ({
        memories: [
          {
            subject: "user",
            type: "preference",
            key: "preference.weather.rain",
            topic: "rain",
            content: "用户喜欢雨天散步。",
            importance: 0.8,
            confidence: 0.9,
          },
          {
            subject: "user",
            type: "preference",
            key: "preference.weather.rain",
            topic: "rain",
            content: "用户喜欢雨天散步。",
            importance: 0.7,
            confidence: 0.8,
          },
        ],
      }),
      embedText: async () => ({
        vector: [1, 0],
        dimension: 2,
        backend: "llama.cpp",
        quality: "semantic",
        model: "bge-m3",
        version: 1,
        needsRefresh: false,
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      userMessage: "我喜欢雨天散步",
      assistantMessage: "我记住了。",
      sourceTaskId: "task-1",
    });

    expect(result.persistedMemoryCount).toBe(2);
    const memories = new MemoryRepository(db).listActiveForScope({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].sourceTaskId).toBe("task-1");
  });
});

describe("MemoryExtractFlow throttling", () => {
  it("short-circuits when shouldThrottle matches fallback_reply and user has no strong signal", async () => {
    const db = createTestDatabase();
    const generateSpy = vi.fn();
    const flow = createMemoryExtractFlow({ db, generateMemoryExtraction: generateSpy });
    const result = await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "好的",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(result.throttled).toBe(true);
    expect(result.throttleReason).toBe("fallback_reply");
    expect(result.persistedMemoryCount).toBe(0);
  });

  it("does NOT throttle when user has strong memory signal even if assistant is fallback", async () => {
    const db = createTestDatabase();
    const generateSpy = vi.fn().mockResolvedValue({ memories: [] });
    const flow = createMemoryExtractFlow({ db, generateMemoryExtraction: generateSpy });
    await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "以后叫我阿梁",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(generateSpy).toHaveBeenCalled();
  });

  it("records one throttled log row per throttled task", async () => {
    const db = createTestDatabase();
    const flow = createMemoryExtractFlow({ db });
    await flow.run({
      userId: "u1", agentId: "a1", worldId: "w1",
      userMessage: "好的",
      assistantMessage: "好的",
    });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'throttled'").all();
    expect(rows).toHaveLength(1);
  });
});
