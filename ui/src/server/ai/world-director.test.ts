import { describe, expect, it, vi } from "vitest";

vi.mock("./structured-output", () => ({
  withStructuredOutput: vi.fn(),
}));

vi.mock("./models", () => ({
  getActiveProviderInfo: vi.fn(() => ({ provider: "minimax", model: "director-model-v1" })),
}));

const { withStructuredOutput } = await import("./structured-output");
const { generateWorldDecision } = await import("./world-director");

describe("generateWorldDecision", () => {
  it("uses structured output with the worldDirector purpose and returns model metadata", async () => {
    vi.mocked(withStructuredOutput).mockResolvedValueOnce({
      observations: ["ok"],
      intent: "no_op",
      events: [],
      commands: [],
      memories: [],
      nextTick: null,
    });

    const result = await generateWorldDecision({ system: "system", prompt: "prompt" });

    expect(withStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "worldDirector",
        system: "system",
        prompt: "prompt",
        temperature: 0.4,
      }),
    );
    expect(result.modelProvider).toBe("minimax");
    expect(result.modelName).toBe("director-model-v1");
    expect(result.rawDecisionJson).toContain("\"intent\":\"no_op\"");
  });
});
