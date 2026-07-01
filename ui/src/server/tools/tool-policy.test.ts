import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { createChatToolsForScope, isChatToolsEnabled } from "./tool-policy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool policy", () => {
  it("enables chat tools only when ENABLE_TOOLS is exactly true", () => {
    vi.stubEnv("ENABLE_TOOLS", "true");
    expect(isChatToolsEnabled()).toBe(true);

    vi.stubEnv("ENABLE_TOOLS", "false");
    expect(isChatToolsEnabled()).toBe(false);

    vi.stubEnv("ENABLE_TOOLS", "TRUE");
    expect(isChatToolsEnabled()).toBe(false);
  });

  it("creates the low-risk chat tool set only when policy allows it", () => {
    const scope = {
      db: createTestDatabase(),
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    };

    vi.stubEnv("ENABLE_TOOLS", "false");
    expect(createChatToolsForScope(scope)).toBeUndefined();

    vi.stubEnv("ENABLE_TOOLS", "true");
    expect(Object.keys(createChatToolsForScope(scope) ?? {}).sort()).toEqual([
      "createFeedPostDraft",
      "createTaskDraft",
      "searchMemories",
    ]);
  });
});
