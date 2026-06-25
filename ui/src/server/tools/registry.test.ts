import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { createLowRiskToolActions } from "./registry";

describe("low-risk tool actions", () => {
  it("searches scoped active memories", async () => {
    const db = createTestDatabase();
    new MemoryRepository(db).create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    });

    const actions = createLowRiskToolActions({ db, userId: "u001", agentId: "agent-default", worldId: "default" });

    await expect(actions.searchMemories({ query: "雨天", limit: 5 })).resolves.toEqual([
      { memory_type: "preference", content: "用户喜欢雨天散步", importance: 0.8 },
    ]);
  });

  it("creates draft-only task and feed payloads", async () => {
    const actions = createLowRiskToolActions({
      db: createTestDatabase(),
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });

    await expect(actions.createTaskDraft({ title: "整理旅行计划", priority: "medium" })).resolves.toMatchObject({
      status: "draft",
      title: "整理旅行计划",
      priority: "medium",
    });
    await expect(
      actions.createFeedPostDraft({
        content: "今天想聊聊旅行计划。",
        topicSeed: "旅行计划",
        postType: "plan",
      }),
    ).resolves.toMatchObject({
      status: "draft",
      agent_id: "agent-default",
      topic_seed: "旅行计划",
    });
  });
});
