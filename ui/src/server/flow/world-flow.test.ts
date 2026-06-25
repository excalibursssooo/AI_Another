import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { createWorldFlow } from "./world-flow";

describe("WorldFlow", () => {
  it("upserts a manually specified world", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({ db });

    const result = await flow.run({
      mode: "manual",
      input: {
        id: "city-night",
        name: "夜城",
        lore: "霓虹雨夜中的城市。",
        tone: "克制、温柔",
        constraints: ["保持城市日常感"],
        seedMemories: ["用户喜欢雨夜"],
      },
    });

    expect(result.world?.id).toBe("city-night");
    expect(new WorldRepository(db).get("city-night")?.tone).toBe("克制、温柔");
  });

  it("creates a deterministic AI world from a prompt", async () => {
    const db = createTestDatabase();
    const flow = createWorldFlow({ db });

    const result = await flow.run({
      mode: "ai",
      prompt: "一座有海风和旧书店的小镇",
    });

    expect(result.world?.name).toContain("海风");
    expect(result.backend).toBe("mock");
    expect(result.model).toBe("local-world-generator");
    expect(result.rawText).toContain("旧书店");
  });
});
