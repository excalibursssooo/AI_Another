import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatReplySchema } from "./schemas";

const mockModel = {};

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }: { schema: unknown }) => ({ __mock_output: schema })),
  },
}));

vi.mock("./models", () => ({
  getLanguageModel: vi.fn(() => mockModel),
}));

const { generateText } = await import("ai");
const { withStructuredOutput } = await import("./structured-output");

describe("withStructuredOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("success path: returns the typed object when generateText returns output", async () => {
    const mockOutput = {
      reply: "x",
      mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
    };
    vi.mocked(generateText).mockResolvedValue({ output: mockOutput } as never);

    const result = await withStructuredOutput({
      schema: ChatReplySchema,
      purpose: "chat",
      prompt: "hello",
      system: "you are a bot",
    });

    expect(result).toEqual(mockOutput);
    // Verify schema was passed to Output.object
    const call = vi.mocked(generateText).mock.calls[0]![0] as Record<string, unknown>;
    expect((call.output as Record<string, unknown>)?.__mock_output).toBe(ChatReplySchema);
  });

  it("undefined output path: throws StructuredOutputError when result.output is undefined", async () => {
    vi.mocked(generateText).mockResolvedValue({ output: undefined } as never);

    await expect(
      withStructuredOutput({
        schema: ChatReplySchema,
        purpose: "chat",
        prompt: "hello",
        system: "you are a bot",
      }),
    ).rejects.toThrow();
    await expect(
      withStructuredOutput({
        schema: ChatReplySchema,
        purpose: "chat",
        prompt: "hello",
        system: "you are a bot",
      }),
    ).rejects.toMatchObject({ name: "StructuredOutputError" });
  });

  it("abort propagation: passes the abortSignal to generateText", async () => {
    const abortController = new AbortController();
    vi.mocked(generateText).mockResolvedValue({ output: undefined } as never);

    // Abort before the call so it rejects
    abortController.abort();

    await expect(
      withStructuredOutput({
        schema: ChatReplySchema,
        purpose: "chat",
        prompt: "hello",
        system: "you are a bot",
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow();

    const call = vi.mocked(generateText).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.abortSignal).toBe(abortController.signal);
  });
});
