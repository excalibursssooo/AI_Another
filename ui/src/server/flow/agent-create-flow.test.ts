import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";
import { GenerateAgentDraft } from "@/server/ai/generators/agent-draft";
import { createAgentCreateFlow } from "./agent-create-flow";

describe("AgentCreateFlow", () => {
  it("persists a manual agent and seeds profile memories", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({ db });

    const result = await flow.run({
      mode: "manual",
      userId: "u001",
      worldId: "default",
      input: {
        name: "林",
        persona: "冷静、专注",
        background: "喜欢在雨夜读书。",
        hobbies: ["阅读"],
        speakingStyle: "简洁",
      },
    });

    expect(result.agent?.id).toMatch(/^agent-/);
    expect(result.agent?.displayName).toBe("林");
    expect(new AgentRepository(db).get(result.agent?.id ?? "")?.persona).toBe("冷静、专注");
    expect(
      new MemoryRepository(db).list({
        userId: "u001",
        agentId: result.agent?.id ?? "",
        worldId: "default",
        status: "active",
      }),
    ).toHaveLength(2);
  });

  it("creates a deterministic AI agent profile when no provider is configured", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({ db });

    const result = await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "一个会记录星星和散步路线的新朋友",
    });

    expect(result.agent?.displayName).toContain("星");
    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-agent-generator");
    expect(result.rawText).toContain("星星");
  });
});

describe("AgentCreateFlow with real LLM provider", () => {
  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "minimax");
    vi.stubEnv("CHAT_MODEL", "MiniMax-M3");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses injected AI generator, persists its draft, and reports real backend/model", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({
      db,
      generateAgentDraft: vi.fn<GenerateAgentDraft>(async () => ({
        name: "星岚",
        displayName: "星岚",
        persona: "AI 生成的温柔性格",
        background: "AI 生成的背景",
        greeting: "你好，我是星岚。",
        speakingStyle: "自然、温柔",
        hobbies: ["画星空", "听故事"],
      })),
    });

    const result = await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "想要一个温柔的角色",
    });

    expect(result.backend).toBe("minimax");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.agent?.displayName).toBe("星岚");
    expect(result.agent?.persona).toBe("AI 生成的温柔性格");
    expect(result.agent?.hobbies).toEqual(["画星空", "听故事"]);
    expect(result.rawText).toBe("想要一个温柔的角色");
  });

  it("passes world context (name, tone, lore) to the injected generator", async () => {
    const db = createTestDatabase();
    const generateAgentDraft = vi.fn<GenerateAgentDraft>(async () => ({
      name: "潮生",
      displayName: "潮生",
      persona: "x",
      background: "x",
      greeting: "x",
      speakingStyle: "x",
      hobbies: [],
    }));
    const flow = createAgentCreateFlow({ db, generateAgentDraft });

    await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "海边长大的角色",
    });

    const call = generateAgentDraft.mock.calls[0][0];
    expect(call.world).not.toBeNull();
    expect(call.world?.name).toBeTruthy();
    expect(call.prompt).toBe("海边长大的角色");
  });

  it("falls back to rule-based draft when injected generator returns null", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({
      db,
      generateAgentDraft: vi.fn<GenerateAgentDraft>(async () => null),
    });

    const result = await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "一个会记录星星和散步路线的新朋友",
    });

    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-agent-generator");
    expect(result.agent?.displayName).toContain("星");
  });

  it("falls back to rule-based draft when injected generator throws", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({
      db,
      generateAgentDraft: vi.fn<GenerateAgentDraft>(async () => {
        throw new Error("upstream timeout");
      }),
    });

    const result = await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "一个会记录星星和散步路线的新朋友",
    });

    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-agent-generator");
    expect(result.agent?.displayName).toContain("星");
  });
});
