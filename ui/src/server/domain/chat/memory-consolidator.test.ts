import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "./repositories";
import { MemoryConsolidator } from "./memory-consolidator";
import type { EmbeddingResult } from "@/server/ai/embeddings";

const semantic = (vector: number[]): EmbeddingResult => ({
  vector,
  dimension: vector.length,
  backend: "llama.cpp",
  quality: "semantic",
  model: "bge-m3",
  version: 1,
  needsRefresh: false,
});

const fallback = (vector: number[]): EmbeddingResult => ({
  vector,
  dimension: vector.length,
  backend: "fallback",
  quality: "lexical",
  model: "fallback-hash-v1",
  version: 1,
  needsRefresh: true,
});

describe("MemoryConsolidator", () => {
  it("merges high-similarity semantic memories", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.model.local",
      topic: "local models",
      content: "用户喜欢本地小模型。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "old",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const embedText = vi.fn(async () => semantic([0.99, 0.01]));
    const consolidator = new MemoryConsolidator({ db, embedText });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        key: "preference.model.local",
        topic: "local models",
        content: "用户偏好本地小模型，尤其是 10B 以下模型。",
        importance: 0.9,
        confidence: 0.8,
      },
    });

    expect(result.action).toBe("merged");
    const active = memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" });
    expect(active).toHaveLength(1);
    expect(active[0].content).toContain("10B 以下");
  });

  it("does not use fallback embeddings for semantic merge", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.food.coffee",
      topic: "coffee",
      content: "用户喜欢咖啡。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([1, 0]),
        model: "fallback-hash-v1",
        backend: "fallback",
        quality: "lexical",
        dimension: 2,
        status: "fallback",
        textHash: "old",
        version: 1,
        needsRefresh: true,
        updatedAt: 1,
      },
    });
    const consolidator = new MemoryConsolidator({ db, embedText: async () => fallback([1, 0]) });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        key: "preference.food.tea",
        topic: "tea",
        content: "用户喜欢茶。",
        importance: 0.5,
        confidence: 0.7,
      },
    });

    expect(result.action).toBe("created");
    expect(memories.listActiveForScope({ userId: "u001", agentId: "agent-default", worldId: "default" })).toHaveLength(2);
  });

  it("checks conflict across topK, not only best match", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      topic: "coffee",
      content: "用户喜欢咖啡馆工作。",
      importance: 0.5,
      confidence: 0.7,
      embedding: {
        json: JSON.stringify([0.9, 0.1]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "one",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const old = memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      topic: "coffee",
      content: "用户喜欢咖啡。",
      importance: 0.6,
      confidence: 0.8,
      embedding: {
        json: JSON.stringify([0.8, 0.2]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "two",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const consolidator = new MemoryConsolidator({ db, embedText: async () => semantic([0.82, 0.18]) });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      candidate: {
        subject: "user",
        type: "preference",
        topic: "coffee",
        content: "用户不喜欢咖啡。",
        importance: 0.9,
        confidence: 0.95,
      },
    });

    expect(result.action).toBe("conflicted");
    const all = memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "all" });
    expect(all.find((item) => item.id === old.id)?.status).toBe("frozen");
  });

  it("does not treat 不喜欢 as both negative and positive", async () => {
    const db = createTestDatabase();
    const consolidator = new MemoryConsolidator({ db, embedText: async () => semantic([1, 0]) });

    expect(consolidator.detectConflictForTest("用户喜欢咖啡。", "用户不喜欢咖啡。", "preference")).toBe(true);
    expect(consolidator.detectConflictForTest("用户不喜欢咖啡。", "用户不是不喜欢咖啡。", "preference")).toBe(false);
  });

  it("propagates provenance and embedding onto the conflict replacement", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      key: "preference.food.coffee",
      topic: "coffee",
      content: "用户喜欢咖啡。",
      importance: 0.6,
      confidence: 0.8,
      embedding: {
        json: JSON.stringify([0.9, 0.1]),
        model: "bge-m3",
        backend: "llama.cpp",
        quality: "semantic",
        dimension: 2,
        status: "ready",
        textHash: "old",
        version: 1,
        needsRefresh: false,
        updatedAt: 1,
      },
    });
    const consolidator = new MemoryConsolidator({
      db,
      embedText: async () => semantic([0.85, 0.15]),
    });

    const result = await consolidator.consolidate({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      sourceMessageId: "msg-99",
      sourceTaskId: "task-conflict",
      candidate: {
        subject: "user",
        type: "preference",
        key: "preference.food.coffee",
        topic: "coffee",
        content: "用户不喜欢咖啡。",
        importance: 0.9,
        confidence: 0.95,
      },
    });

    expect(result.action).toBe("conflicted");
    const all = memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "all" });
    const replacement = all.find((item) => item.id === result.memoryId);
    expect(replacement).toBeDefined();
    expect(replacement?.key).toBe("preference.food.coffee");
    expect(replacement?.topic).toBe("coffee");
    expect(replacement?.embeddingJson).toBe(JSON.stringify([0.85, 0.15]));
    expect(replacement?.embeddingStatus).toBe("ready");
    expect(replacement?.sourceTaskId).toBe("task-conflict");
    expect(replacement?.sourceMessageId).toBe("msg-99");
    expect(replacement?.lastObservedAt).toEqual(expect.any(Number));
  });
});
