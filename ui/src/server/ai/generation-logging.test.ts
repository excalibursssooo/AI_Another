import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredOutputError } from "./structured-output";
import { logAiGenerationFallback } from "./generation-logging";

describe("logAiGenerationFallback", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("writes a structured ai-generation fallback warning", () => {
    logAiGenerationFallback({
      purpose: "feed",
      outcome: "fallback_null",
      error: new StructuredOutputError("FeedPostDraft", "missing_output"),
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0];
    expect(tag).toBe("[ai-generation]");
    expect(JSON.parse(String(payload))).toEqual({
      purpose: "feed",
      outcome: "fallback_null",
      errorName: "StructuredOutputError",
      reason: "missing_output",
      schemaName: "FeedPostDraft",
    });
  });
});
