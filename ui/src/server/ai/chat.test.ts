import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn(({ schema }: { schema: unknown }) => ({ __mock_output: schema })) },
}));

const openaiChatSpy = vi.fn(() => ({ provider: "openai-mock" }));
const createOpenAISpy = vi.fn(() => ({ chat: openaiChatSpy }));
const anthropicSpy = vi.fn(() => ({ provider: "anthropic-mock" }));
const googleSpy = vi.fn(() => ({ provider: "google-mock" }));
const deepseekSpy = vi.fn(() => ({ provider: "deepseek-mock" }));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAISpy,
  openai: { chat: openaiChatSpy },
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: anthropicSpy,
}));
vi.mock("@ai-sdk/google", () => ({
  google: googleSpy,
}));
vi.mock("@ai-sdk/deepseek", () => ({
  deepseek: deepseekSpy,
}));

vi.mock("./structured-output", () => ({
  withStructuredOutput: vi.fn(),
  StructuredOutputError: class StructuredOutputError extends Error {
    name = "StructuredOutputError";
    constructor(public readonly schemaName: string) {
      super(`Structured output generation failed for schema: ${schemaName}`);
    }
  },
}));

const { generateText } = await import("ai");
const structuredOutput = await import("./structured-output");
const wso = structuredOutput.withStructuredOutput as ReturnType<typeof vi.fn>;
const SOE = structuredOutput.StructuredOutputError;
const {
  generateAgentDraft,
  generateChatReply,
  generateWorldDraft,
  getActiveProviderInfo,
  getLanguageModel,
  isMockProvider,
} = await import("./chat");


const PROVIDER_ENV_KEYS = [
  "AI_PROVIDER",
  "CHAT_MODEL",
  "AGENT_CREATOR_MODEL",
  "WORLD_CREATOR_MODEL",
  "MEMORY_MODEL",
  "FEED_MODEL",
  "WORLD_DIRECTOR_MODEL",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

function stubProviderEnv(values: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>): void {
  for (const key of PROVIDER_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
}

beforeEach(() => {
  createOpenAISpy.mockClear();
  openaiChatSpy.mockClear();
  anthropicSpy.mockClear();
  googleSpy.mockClear();
  deepseekSpy.mockClear();
  vi.mocked(generateText).mockReset();
  wso.mockReset();
  stubProviderEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isMockProvider", () => {
  it("returns true when AI_PROVIDER is unset", () => {
    stubProviderEnv({ AI_PROVIDER: undefined });
    expect(isMockProvider()).toBe(true);
  });

  it("returns true when AI_PROVIDER is 'mock'", () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    expect(isMockProvider()).toBe(true);
  });

  it("is case-insensitive (MOCK)", () => {
    stubProviderEnv({ AI_PROVIDER: "MOCK" });
    expect(isMockProvider()).toBe(true);
  });

  it("returns false when AI_PROVIDER is 'minimax'", () => {
    stubProviderEnv({ AI_PROVIDER: "minimax" });
    expect(isMockProvider()).toBe(false);
  });
});

describe("getActiveProviderInfo", () => {
  it("returns the lowercase provider and trimmed model", () => {
    stubProviderEnv({ AI_PROVIDER: "MINIMAX", CHAT_MODEL: "  MiniMax-M3  " });
    expect(getActiveProviderInfo()).toEqual({ provider: "minimax", model: "MiniMax-M3" });
  });

  it("defaults to 'mock' provider and 'mock' model when unset", () => {
    stubProviderEnv({});
    expect(getActiveProviderInfo()).toEqual({ provider: "mock", model: "mock" });
  });
});

describe("getLanguageModel", () => {
  it("returns null when provider is mock", () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    expect(getLanguageModel("chat")).toBeNull();
  });

  it("returns null when minimax env is incomplete (missing key)", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    expect(getLanguageModel("chat")).toBeNull();
  });

  it("returns null when minimax env is incomplete (missing model)", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    expect(getLanguageModel("chat")).toBeNull();
  });

  it("creates a model via createOpenAI for minimax when env is fully set", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const model = getLanguageModel("chat");
    expect(model).toBeTruthy();
    expect(createOpenAISpy).toHaveBeenCalledWith({
      name: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/v1",
    });
    expect(openaiChatSpy).toHaveBeenCalledWith("MiniMax-M3");
  });

  it("uses AGENT_CREATOR_MODEL for the agent creator purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      AGENT_CREATOR_MODEL: "agent-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("agentCreator");
    expect(openaiChatSpy).toHaveBeenCalledWith("agent-model-v1");
  });

  it("uses WORLD_CREATOR_MODEL for the world creator purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      WORLD_CREATOR_MODEL: "world-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("worldCreator");
    expect(openaiChatSpy).toHaveBeenCalledWith("world-model-v1");
  });

  it("uses MEMORY_MODEL for the memory purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MEMORY_MODEL: "memory-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("memory");
    expect(openaiChatSpy).toHaveBeenCalledWith("memory-model-v1");
  });

  it("uses FEED_MODEL for the feed purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      FEED_MODEL: "feed-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("feed");
    expect(openaiChatSpy).toHaveBeenCalledWith("feed-model-v1");
  });

  it("uses WORLD_DIRECTOR_MODEL for the world director purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      WORLD_DIRECTOR_MODEL: "director-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("worldDirector");
    expect(openaiChatSpy).toHaveBeenCalledWith("director-model-v1");
  });

  it("falls back to CHAT_MODEL when purpose-specific model is empty", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("agentCreator");
    expect(openaiChatSpy).toHaveBeenCalledWith("MiniMax-M3");
  });

  it("returns a model for openai provider with default model when CHAT_MODEL is empty", () => {
    stubProviderEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-openai" });
    getLanguageModel("chat");
    expect(openaiChatSpy).toHaveBeenCalledWith("gpt-4o-mini");
  });

  it("returns a model for anthropic provider with default model when CHAT_MODEL is empty", () => {
    stubProviderEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" });
    getLanguageModel("chat");
    expect(anthropicSpy).toHaveBeenCalledWith("claude-3-5-haiku-latest");
  });

  it("returns a model for google provider with default model when CHAT_MODEL is empty", () => {
    stubProviderEnv({ AI_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: "goog" });
    getLanguageModel("chat");
    expect(googleSpy).toHaveBeenCalledWith("gemini-2.0-flash");
  });

  it("returns a model for deepseek provider with default model when CHAT_MODEL is empty", () => {
    stubProviderEnv({ AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds" });
    getLanguageModel("chat");
    expect(deepseekSpy).toHaveBeenCalledWith("deepseek-chat");
  });

  it("returns null for an unknown provider", () => {
    stubProviderEnv({ AI_PROVIDER: "mystery-provider" });
    expect(getLanguageModel("chat")).toBeNull();
  });
});

describe("generateChatReply", () => {
  it("returns the mock reply when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("我在这里。你刚才说的我记住了。");
    expect(result.mood.label).toBe("calm");
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns fallback when no model can be resolved", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("当前模型暂时不可用，但我已经收到你的消息了。");
    expect(result.mood).toEqual({ label: "neutral", intensity: 0.25, heartbeatBpm: 72 });
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns parsed ChatReply on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const parsedReply = {
      reply: "hi",
      mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
    };
    wso.mockResolvedValue(parsedReply as never);
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result).toEqual(parsedReply);
  });

  it("returns fallback when withStructuredOutput throws StructuredOutputError", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new SOE("x") as never);
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("当前模型暂时不可用，但我已经收到你的消息了。");
    expect(result.mood).toEqual({ label: "neutral", intensity: 0.25, heartbeatBpm: 72 });
  });

  it("rethrows when withStructuredOutput throws non-SOE error", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new Error("network down") as never);
    await expect(generateChatReply({ system: "sys", prompt: "hi" })).rejects.toThrow("network down");
  });

  it("appends system prompt and forwards prompt verbatim", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const parsedReply = {
      reply: "hi",
      mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
    };
    wso.mockResolvedValue(parsedReply as never);
    await generateChatReply({ system: "原始 system", prompt: "用户的提问" });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.system).toBe("原始 system");
    expect(call.prompt).toBe("用户的提问");
  });

  it("temperature is 0.7 by default", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const parsedReply = {
      reply: "hi",
      mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
    };
    wso.mockResolvedValue(parsedReply as never);
    await generateChatReply({ system: "sys", prompt: "hi" });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.7);
  });
});

describe("generateAgentDraft", () => {
  const VALID_AGENT_DRAFT = {
    name: "星岚",
    displayName: "星岚",
    persona: "温柔",
    background: "背景",
    greeting: "你好",
    speakingStyle: "自然",
    hobbies: ["a", "b"],
  };

  it("returns null when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns null when no model can be resolved", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns parsed AgentDraft on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_AGENT_DRAFT as never);
    const result = await generateAgentDraft({ prompt: "想要一个温柔的角色" });
    expect(result).toEqual(VALID_AGENT_DRAFT);
  });

  it("includes world context in the prompt when world is provided", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_AGENT_DRAFT as never);
    await generateAgentDraft({
      prompt: "x",
      world: { id: "w1", name: "潮鸣镇", lore: "南方小镇", tone: "静谧、潮湿" },
    });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.prompt).toContain("潮鸣镇");
    expect(call.prompt).toContain("静谧、潮湿");
    expect(call.prompt).toContain("南方小镇");
  });

  it("omits the world block when world is null", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_AGENT_DRAFT as never);
    await generateAgentDraft({ prompt: "x", world: null });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.prompt).not.toContain("所在世界");
  });

  it("returns null when withStructuredOutput throws StructuredOutputError", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new SOE("invalid output") as never);
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
  });

  it("returns null when withStructuredOutput throws any other error", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new Error("boom") as never);
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
  });
});

describe("generateWorldDraft", () => {
  const VALID_WORLD_DRAFT = {
    id: "coastal-bookshop",
    name: "潮鸣镇",
    lore: "南方小镇",
    tone: "静谧",
    constraints: ["规则1"],
    seedMemories: ["记忆1"],
  };

  it("returns null when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns null when no model can be resolved", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(wso).not.toHaveBeenCalled();
  });

  it("returns parsed WorldDraft on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_WORLD_DRAFT as never);
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toEqual(VALID_WORLD_DRAFT);
  });

  it("includes worldId hint when provided", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_WORLD_DRAFT as never);
    await generateWorldDraft({ prompt: "x", worldId: "city-night" });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.prompt).toContain("city-night");
    expect(call.prompt).toContain("用户偏好的世界 id");
  });

  it("omits the worldId hint when worldId is empty/null", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockResolvedValue(VALID_WORLD_DRAFT as never);
    await generateWorldDraft({ prompt: "x", worldId: null });
    const call = wso.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.prompt).not.toContain("用户偏好的世界 id");
  });

  it("returns null when withStructuredOutput throws StructuredOutputError", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new SOE("invalid output") as never);
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
  });

  it("returns null when withStructuredOutput throws any other error", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    wso.mockRejectedValue(new Error("boom") as never);
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
  });
});
