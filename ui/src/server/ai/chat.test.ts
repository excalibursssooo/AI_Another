import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
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

const { generateText } = await import("ai");
const {
  extractJsonPayload,
  generateAgentDraft,
  generateChatReply,
  generateWorldDraft,
  getActiveProviderInfo,
  getLanguageModel,
  isMockProvider,
  parseJsonWithSchema,
  stripThinkingBlocks,
} = await import("./chat");
const { AgentDraftSchema, ChatReplySchema, WorldDraftSchema } = await import("./schemas");

const PROVIDER_ENV_KEYS = [
  "AI_PROVIDER",
  "CHAT_MODEL",
  "AGENT_CREATOR_MODEL",
  "WORLD_CREATOR_MODEL",
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

  it("uses AGENT_CREATOR_MODEL for the 'agent' purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      AGENT_CREATOR_MODEL: "agent-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("agent");
    expect(openaiChatSpy).toHaveBeenCalledWith("agent-model-v1");
  });

  it("uses WORLD_CREATOR_MODEL for the 'world' purpose", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      WORLD_CREATOR_MODEL: "world-model-v1",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("world");
    expect(openaiChatSpy).toHaveBeenCalledWith("world-model-v1");
  });

  it("falls back to CHAT_MODEL when purpose-specific model is empty", () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    getLanguageModel("agent");
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

describe("stripThinkingBlocks", () => {
  it("removes a single <think>...</think> block", () => {
    expect(stripThinkingBlocks("<think>hidden</think>hello")).toBe("hello");
  });

  it("removes multiple blocks", () => {
    expect(stripThinkingBlocks("<think>a</think>middle<think>b</think>end")).toBe("middleend");
  });

  it("handles multiline thinking content", () => {
    const input = "<think>\nline1\nline2\n</think>\nresult";
    expect(stripThinkingBlocks(input)).toBe("result");
  });

  it("is case-insensitive on tag names", () => {
    expect(stripThinkingBlocks("<THINK>x</think>ok")).toBe("ok");
    expect(stripThinkingBlocks("<think>y</THINK>ok")).toBe("ok");
  });

  it("returns trimmed text when no blocks are present", () => {
    expect(stripThinkingBlocks("  plain text  ")).toBe("plain text");
  });

  it("returns empty string when input is only thinking blocks", () => {
    expect(stripThinkingBlocks("<think>all hidden</think>")).toBe("");
  });
});

describe("extractJsonPayload", () => {
  it("returns stripped text when there is no fence", () => {
    expect(extractJsonPayload("<think>x</think>{\"a\":1}")).toBe('{"a":1}');
  });

  it("extracts content from a ```json fenced block", () => {
    const input = "<think>x</think>```json\n{\"a\":1}\n```";
    expect(extractJsonPayload(input)).toBe('{"a":1}');
  });

  it("extracts content from a ``` fenced block (no language hint)", () => {
    const input = "```\n{\"a\":1}\n```";
    expect(extractJsonPayload(input)).toBe('{"a":1}');
  });

  it("combines think-stripping and fence-extraction", () => {
    const input = "<think>hidden</think>```json\n{\"a\":1}\n```";
    expect(extractJsonPayload(input)).toBe('{"a":1}');
  });
});

describe("parseJsonWithSchema", () => {
  it("parses valid JSON that matches the schema", () => {
    const text = '{"reply":"hi","mood":{"label":"calm","intensity":0.5,"heartbeatBpm":72}}';
    const result = parseJsonWithSchema(text, ChatReplySchema);
    expect(result).toEqual({
      reply: "hi",
      mood: { label: "calm", intensity: 0.5, heartbeatBpm: 72 },
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonWithSchema("not json", ChatReplySchema)).toBeNull();
  });

  it("returns null for valid JSON that fails schema validation", () => {
    const text = '{"reply":"hi","mood":{"label":"calm","intensity":0.5,"heartbeatBpm":999}}';
    expect(parseJsonWithSchema(text, ChatReplySchema)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseJsonWithSchema("", ChatReplySchema)).toBeNull();
  });

  it("strips thinking blocks before parsing", () => {
    const input = '<think>hidden</think>{"reply":"hi","mood":{"label":"calm","intensity":0.5,"heartbeatBpm":72}}';
    expect(parseJsonWithSchema(input, ChatReplySchema)).not.toBeNull();
  });

  it("strips code fence before parsing", () => {
    const input = '```json\n{"reply":"hi","mood":{"label":"calm","intensity":0.5,"heartbeatBpm":72}}\n```';
    expect(parseJsonWithSchema(input, ChatReplySchema)).not.toBeNull();
  });

  it("validates AgentDraftSchema", () => {
    const valid = JSON.stringify({
      name: "星岚",
      displayName: "星岚",
      persona: "温柔",
      background: "背景",
      greeting: "你好",
      speakingStyle: "自然",
      hobbies: ["a", "b"],
    });
    expect(parseJsonWithSchema(valid, AgentDraftSchema)).not.toBeNull();
    const missing = JSON.stringify({ name: "x" });
    expect(parseJsonWithSchema(missing, AgentDraftSchema)).toBeNull();
  });

  it("validates WorldDraftSchema", () => {
    const valid = JSON.stringify({
      id: "coastal-bookshop",
      name: "潮鸣镇",
      lore: "x",
      tone: "静谧",
      constraints: [],
      seedMemories: [],
    });
    expect(parseJsonWithSchema(valid, WorldDraftSchema)).not.toBeNull();
  });
});

describe("generateChatReply", () => {
  const VALID_REPLY_JSON =
    '{"reply":"hi","mood":{"label":"calm","intensity":0.5,"heartbeatBpm":72}}';

  it("returns the mock reply when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("我在这里。你刚才说的我记住了。");
    expect(result.mood.label).toBe("calm");
    expect(generateText).not.toHaveBeenCalled();
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
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns parsed ChatReply on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_REPLY_JSON } as never);
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("hi");
    expect(result.mood.label).toBe("calm");
  });

  it("strips thinking blocks from the model output before parsing", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({
      text: `<think>reasoning</think>${VALID_REPLY_JSON}`,
    } as never);
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("hi");
  });

  it("appends the JSON format instruction to the system prompt", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_REPLY_JSON } as never);
    await generateChatReply({ system: "原始 system", prompt: "hi" });
    const call = vi.mocked(generateText).mock.calls[0][0];
    expect(call.system).toContain("原始 system");
    expect(call.system).toContain("输出格式要求");
    expect(call.temperature).toBe(0.7);
  });

  it("returns fallback when model throws", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockRejectedValue(new Error("network down"));
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("当前模型暂时不可用，但我已经收到你的消息了。");
  });

  it("returns fallback when JSON parse fails", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: "not json at all" } as never);
    const result = await generateChatReply({ system: "sys", prompt: "hi" });
    expect(result.reply).toBe("当前模型暂时不可用，但我已经收到你的消息了。");
  });
});

describe("generateAgentDraft", () => {
  const VALID_AGENT_JSON = JSON.stringify({
    name: "星岚",
    displayName: "星岚",
    persona: "温柔",
    background: "背景",
    greeting: "你好",
    speakingStyle: "自然",
    hobbies: ["a", "b"],
  });

  it("returns null when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
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
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns parsed AgentDraft on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      AGENT_CREATOR_MODEL: "agent-model",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_AGENT_JSON } as never);
    const result = await generateAgentDraft({ prompt: "想要一个温柔的角色" });
    expect(result).not.toBeNull();
    expect(result?.name).toBe("星岚");
    expect(result?.hobbies).toEqual(["a", "b"]);
  });

  it("includes world context in the prompt when world is provided", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_AGENT_JSON } as never);
    await generateAgentDraft({
      prompt: "x",
      world: { id: "w1", name: "潮鸣镇", lore: "南方小镇", tone: "静谧、潮湿" },
    });
    const call = vi.mocked(generateText).mock.calls[0][0];
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
    vi.mocked(generateText).mockResolvedValue({ text: VALID_AGENT_JSON } as never);
    await generateAgentDraft({ prompt: "x", world: null });
    const call = vi.mocked(generateText).mock.calls[0][0];
    expect(call.prompt).not.toContain("所在世界");
  });

  it("returns null when parse fails", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: "garbage" } as never);
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
  });

  it("returns null when model throws", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockRejectedValue(new Error("boom"));
    const result = await generateAgentDraft({ prompt: "x" });
    expect(result).toBeNull();
  });
});

describe("generateWorldDraft", () => {
  const VALID_WORLD_JSON = JSON.stringify({
    id: "coastal-bookshop",
    name: "潮鸣镇",
    lore: "南方小镇",
    tone: "静谧",
    constraints: ["规则1"],
    seedMemories: ["记忆1"],
  });

  it("returns null when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
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
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns parsed WorldDraft on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      WORLD_CREATOR_MODEL: "world-model",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_WORLD_JSON } as never);
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).not.toBeNull();
    expect(result?.id).toBe("coastal-bookshop");
    expect(result?.name).toBe("潮鸣镇");
  });

  it("includes worldId hint when provided", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: VALID_WORLD_JSON } as never);
    await generateWorldDraft({ prompt: "x", worldId: "city-night" });
    const call = vi.mocked(generateText).mock.calls[0][0];
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
    vi.mocked(generateText).mockResolvedValue({ text: VALID_WORLD_JSON } as never);
    await generateWorldDraft({ prompt: "x", worldId: null });
    const call = vi.mocked(generateText).mock.calls[0][0];
    expect(call.prompt).not.toContain("用户偏好的世界 id");
  });

  it("returns null when parse fails", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockResolvedValue({ text: "garbage" } as never);
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
  });

  it("returns null when model throws", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    vi.mocked(generateText).mockRejectedValue(new Error("boom"));
    const result = await generateWorldDraft({ prompt: "x" });
    expect(result).toBeNull();
  });
});