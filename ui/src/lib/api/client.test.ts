import { describe, expect, it } from "vitest";

import { buildApiUrl, resolveApiBaseUrl } from "./client";

describe("API client URL resolution", () => {
  it("uses same-origin /api by default", () => {
    expect(resolveApiBaseUrl({ nodeEnv: "development" })).toBe("/api");
    expect(resolveApiBaseUrl({ nodeEnv: "production" })).toBe("/api");
    expect(buildApiUrl("/chat", "/api")).toBe("/api/chat");
  });

  it("keeps absolute configured API base URLs", () => {
    expect(resolveApiBaseUrl({ nodeEnv: "development", apiBaseUrl: "http://127.0.0.1:8000" })).toBe(
      "http://127.0.0.1:8000",
    );
    expect(buildApiUrl("/chat", "http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/chat");
  });
});
