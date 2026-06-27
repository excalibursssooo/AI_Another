import { describe, expect, it } from "vitest";

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
});
