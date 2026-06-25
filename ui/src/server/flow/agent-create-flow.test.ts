import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { AgentRepository, MemoryRepository } from "@/server/domain/chat/repositories";
import { createAgentCreateFlow } from "./agent-create-flow";

describe("AgentCreateFlow", () => {
  it("persists a manual agent and seeds profile memories", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({ db });

    const result = await flow.run({
      mode: "manual",
      userId: "u001",
      worldId: "default",
      input: {
        name: "林",
        persona: "冷静、专注",
        background: "喜欢在雨夜读书。",
        hobbies: ["阅读"],
        speakingStyle: "简洁",
      },
    });

    expect(result.agent?.id).toMatch(/^agent-/);
    expect(result.agent?.displayName).toBe("林");
    expect(new AgentRepository(db).get(result.agent?.id ?? "")?.persona).toBe("冷静、专注");
    expect(
      new MemoryRepository(db).list({
        userId: "u001",
        agentId: result.agent?.id ?? "",
        worldId: "default",
        status: "active",
      }),
    ).toHaveLength(2);
  });

  it("creates a deterministic AI agent profile when no provider is configured", async () => {
    const db = createTestDatabase();
    const flow = createAgentCreateFlow({ db });

    const result = await flow.run({
      mode: "ai",
      userId: "u001",
      worldId: "default",
      prompt: "一个会记录星星和散步路线的新朋友",
    });

    expect(result.agent?.displayName).toContain("星");
    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-agent-generator");
    expect(result.rawText).toContain("星星");
  });
});
