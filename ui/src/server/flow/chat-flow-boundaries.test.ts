import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("ChatFlow boundaries", () => {
  const source = () => readFileSync(join(process.cwd(), "src/server/flow/chat-flow.ts"), "utf8");

  it("does not read process.env directly", () => {
    expect(source()).not.toContain("process.env");
  });

  it("keeps repository construction outside the flow definition", () => {
    const flowSource = source();

    expect(flowSource).not.toContain("new AgentRepository");
    expect(flowSource).not.toContain("new WorldRepository");
    expect(flowSource).not.toContain("new ConversationRepository");
    expect(flowSource).not.toContain("new MemoryRepository");
    expect(flowSource).not.toContain("new AgentLiveStateRepository");
    expect(flowSource).not.toContain("new TaskRepository");
  });
});
