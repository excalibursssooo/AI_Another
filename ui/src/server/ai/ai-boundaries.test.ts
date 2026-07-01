import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("AI module boundaries", () => {
  const sourceFor = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("keeps feed post generation outside the chat compatibility module", () => {
    const source = sourceFor("src/server/ai/chat.ts");

    expect(source).not.toContain("const FEED_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateFeedPostDraft");
  });

  it("keeps world draft generation outside the chat compatibility module", () => {
    const source = sourceFor("src/server/ai/chat.ts");

    expect(source).not.toContain("const WORLD_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateWorldDraft");
  });

  it("keeps agent draft generation outside the chat compatibility module", () => {
    const source = sourceFor("src/server/ai/chat.ts");

    expect(source).not.toContain("const AGENT_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateAgentDraft");
  });

  it("keeps memory extraction generation outside the chat compatibility module", () => {
    const source = sourceFor("src/server/ai/chat.ts");

    expect(source).not.toContain("const MEMORY_SYSTEM_PROMPT");
    expect(source).not.toContain("async function generateMemoryExtraction");
  });

  it("keeps chat generation implementation outside the chat compatibility module", () => {
    const source = sourceFor("src/server/ai/chat.ts");

    expect(source).not.toContain('from "ai"');
    expect(source).not.toContain("async function generateChatReply");
    expect(source).not.toContain("async function streamChatReply");
  });

  it("keeps production flows pointed at focused AI generator modules", () => {
    const flowFiles = [
      "src/server/flow/agent-create-flow.ts",
      "src/server/flow/chat-flow.ts",
      "src/server/flow/feed-flow.ts",
      "src/server/flow/memory-extract-flow.ts",
      "src/server/flow/task-worker.ts",
      "src/server/flow/world-flow.ts",
    ];

    for (const file of flowFiles) {
      expect(sourceFor(file), file).not.toContain("@/server/ai/chat");
    }
  });
});
