import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { createLowRiskToolActions, createChatToolSet } from "./registry";

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

describe("createChatToolSet", () => {
  it("searchMemories.description is a non-empty string", () => {
    const toolSet = createChatToolSet({
      db: createTestDatabase(),
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });
    expect(typeof toolSet.searchMemories.description).toBe("string");
    expect(toolSet.searchMemories.description!.length).toBeGreaterThan(0);
  });

  it("searchMemories.execute returns the same shape as createLowRiskToolActions", async () => {
    const db = createTestDatabase();
    new MemoryRepository(db).create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "test memory content",
      importance: 0.7,
      confidence: 0.85,
    });

    const scope = { db, userId: "u001", agentId: "agent-default", worldId: "default" };
    const actions = createLowRiskToolActions(scope);
    const toolSet = createChatToolSet(scope);

    const actionResult = await actions.searchMemories({ query: "test", limit: 3 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executeResult = await (toolSet.searchMemories as any).execute({ query: "test", limit: 3 });

    expect(executeResult).toEqual(actionResult);
  });

  it("createTaskDraft.execute returns shape with status:draft", async () => {
    const toolSet = createChatToolSet({
      db: createTestDatabase(),
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((toolSet.createTaskDraft as any).execute({ title: "x", priority: "medium" })).resolves.toMatchObject({
      status: "draft",
    });
  });

  it("createFeedPostDraft.execute returns shape with status:draft", async () => {
    const toolSet = createChatToolSet({
      db: createTestDatabase(),
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });

    await expect(
      /* eslint-disable @typescript-eslint/no-explicit-any */ (toolSet.createFeedPostDraft as any).execute({
        content: "x",
        topicSeed: "x",
        postType: "status",
      }),
    ).resolves.toMatchObject({ status: "draft" });
  });
});
