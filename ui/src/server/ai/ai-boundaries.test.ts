import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("AI module boundaries", () => {
  it("keeps feed post generation outside the chat compatibility module", () => {
    const source = readFileSync(join(process.cwd(), "src/server/ai/chat.ts"), "utf8");

    expect(source).not.toContain("const FEED_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateFeedPostDraft");
  });

  it("keeps world draft generation outside the chat compatibility module", () => {
    const source = readFileSync(join(process.cwd(), "src/server/ai/chat.ts"), "utf8");

    expect(source).not.toContain("const WORLD_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateWorldDraft");
  });
});
