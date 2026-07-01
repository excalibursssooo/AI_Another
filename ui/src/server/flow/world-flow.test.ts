import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { GenerateWorldDraft } from "@/server/ai/generators/world-draft";
import { createWorldFlow } from "./world-flow";

describe("WorldFlow", () => {
  it("upserts a manually specified world", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({ db });

    const result = await flow.run({
      mode: "manual",
      input: {
        id: "city-night",
        name: "夜城",
        lore: "霓虹雨夜中的城市。",
        tone: "克制、温柔",
        constraints: ["保持城市日常感"],
        seedMemories: ["用户喜欢雨夜"],
      },
    });

    expect(result.world?.id).toBe("city-night");
    expect(new WorldRepository(db).get("city-night")?.tone).toBe("克制、温柔");
  });

  it("creates a deterministic AI world from a prompt", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({ db });

    const result = await flow.run({
      mode: "ai",
      prompt: "一座有海风和旧书店的小镇",
    });

    expect(result.world?.name).toContain("海风");
    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-world-generator");
    expect(result.rawText).toContain("旧书店");
  });
});

describe("WorldFlow with real LLM provider", () => {
  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "minimax");
    vi.stubEnv("CHAT_MODEL", "MiniMax-M3");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses injected AI generator, persists its draft, and reports real backend/model", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({
      db,
      generateWorldDraft: vi.fn<GenerateWorldDraft>(async () => ({
        id: "coastal-bookshop",
        name: "潮鸣镇",
        lore: "AI 生成的世界观",
        tone: "静谧、潮湿",
        constraints: ["规则1"],
        seedMemories: ["记忆1"],
      })),
    });

    const result = await flow.run({
      mode: "ai",
      prompt: "南方沿海小镇",
    });

    expect(result.backend).toBe("minimax");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.world?.id).toBe("coastal-bookshop");
    expect(result.world?.name).toBe("潮鸣镇");
    expect(result.world?.tone).toBe("静谧、潮湿");
    expect(result.rawText).toBe("南方沿海小镇");
  });

  it("passes worldId hint through to the injected generator", async () => {
    const db = createTestDatabase();
    const generateWorldDraft = vi.fn<GenerateWorldDraft>(async () => ({
      id: "coastal-bookshop",
      name: "潮鸣镇",
      lore: "x",
      tone: "x",
      constraints: [],
      seedMemories: [],
    }));
    const flow = createWorldFlow({ db, generateWorldDraft });

    await flow.run({
      mode: "ai",
      prompt: "x",
      worldId: "city-night",
    });

    expect(generateWorldDraft.mock.calls[0][0].worldId).toBe("city-night");
  });

  it("falls back to rule-based world when injected generator returns null", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({
      db,
      generateWorldDraft: vi.fn<GenerateWorldDraft>(async () => null),
    });

    const result = await flow.run({
      mode: "ai",
      prompt: "一座有海风和旧书店的小镇",
    });

    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-world-generator");
    expect(result.world?.name).toContain("海风");
  });

  it("falls back to rule-based world when injected generator throws", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({
      db,
      generateWorldDraft: vi.fn<GenerateWorldDraft>(async () => {
        throw new Error("upstream timeout");
      }),
    });

    const result = await flow.run({
      mode: "ai",
      prompt: "一座有海风和旧书店的小镇",
    });

    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-world-generator");
    expect(result.world?.name).toContain("海风");
  });
});
