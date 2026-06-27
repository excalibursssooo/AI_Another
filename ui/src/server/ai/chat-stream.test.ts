import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
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

const { streamText } = await import("ai");
const { streamChatReply } = await import("./chat");

const PROVIDER_ENV_KEYS = [
  "AI_PROVIDER",
  "CHAT_MODEL",
  "AGENT_CREATOR_MODEL",
  "WORLD_CREATOR_MODEL",
  "MEMORY_MODEL",
  "FEED_MODEL",
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
  vi.mocked(streamText).mockReset();
  stubProviderEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("streamChatReply", () => {
  it("returns a stream of text chunks that yields multiple chunks on success", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const parsedReply = {
      reply: "你好",
      mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
    };
    async function* textChunks() {
      yield "你";
      yield "好";
    }
    async function* fullEvents() {
      yield { type: "text-delta", textDelta: "你" };
      yield { type: "text-delta", textDelta: "好" };
    }
    vi.mocked(streamText).mockReturnValue({
      textStream: textChunks(),
      fullStream: fullEvents(),
      output: Promise.resolve(parsedReply),
    } as never);

    const result = await streamChatReply({ system: "sys", prompt: "hi" });

    const collected: string[] = [];
    for await (const chunk of result.textStream) {
      collected.push(chunk);
    }
    expect(collected).toEqual(["你", "好"]);
    expect(await result.object).toEqual(parsedReply);
    expect(result.model).toBeTruthy();
    expect(result.fullStream).toBeDefined();
  });

  it("returns the mock single-chunk reply when provider is mock", async () => {
    stubProviderEnv({ AI_PROVIDER: "mock" });
    const result = await streamChatReply({ system: "sys", prompt: "hi" });
    expect(vi.mocked(streamText)).not.toHaveBeenCalled();

    const collected: string[] = [];
    for await (const chunk of result.textStream) {
      collected.push(chunk);
    }
    expect(collected).toEqual(["我在这里。你刚才说的我记住了。"]);
    expect(await result.object).toEqual({
      reply: "我在这里。你刚才说的我记住了。",
      mood: { label: "calm", intensity: 0.35, heartbeatBpm: 72 },
    });
  });

  it("returns the fallback chunk + object when no model can be resolved", async () => {
    stubProviderEnv({
      AI_PROVIDER: "minimax",
      CHAT_MODEL: "MiniMax-M3",
      MINIMAX_API_KEY: "",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    });
    const result = await streamChatReply({ system: "sys", prompt: "hi" });
    expect(vi.mocked(streamText)).not.toHaveBeenCalled();

    const collected: string[] = [];
    for await (const chunk of result.textStream) {
      collected.push(chunk);
    }
    expect(collected).toEqual(["当前模型暂时不可用，但我已经收到你的消息了。"]);
    expect(await result.object).toEqual({
      reply: "当前模型暂时不可用，但我已经收到你的消息了。",
      mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
    });
  });
});