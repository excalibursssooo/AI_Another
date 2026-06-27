import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ConversationRepository, FeedPostRepository } from "@/server/domain/chat/repositories";
import { createFeedGenerateFlow, createPostTrigger } from "./feed-flow";

describe("FeedGenerateFlow", () => {
  it("generates and persists a feed post for an agent", async () => {
    const db = createTestDatabase();
    const conversations = new ConversationRepository(db);
    const conversationId = conversations.ensureConversation({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });
    conversations.appendMessage({ conversationId, role: "user", content: "今天想聊聊海边散步" });

    const result = await createFeedGenerateFlow({ db }).run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      sourceTaskId: null,
    });

    expect(result.skipped).toBe(false);
    expect(result.post?.content).toContain("海边散步");
    expect(new FeedPostRepository(db).list({ userId: "u001", worldId: "default", limit: 20, offset: 0, includeArchived: false }).total).toBe(1);
  });

  it("persists AI-generated feed draft fields when a generator returns structured output", async () => {
    const db = createTestDatabase();

    const result = await createFeedGenerateFlow({
      db,
      generateFeedPostDraft: async () => ({
        content: "今晚想把雨声写进日记。",
        topicSeed: "雨声日记",
        postType: "reflection",
      }),
    }).run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      sourceTaskId: "task-feed",
    });

    expect(result.post).toMatchObject({
      content: "今晚想把雨声写进日记。",
      topicSeed: "雨声日记",
      postType: "reflection",
      sourceTaskId: "task-feed",
    });
    expect(
      new FeedPostRepository(db).list({ userId: "u001", worldId: "default", limit: 20, offset: 0, includeArchived: false })
        .items[0],
    ).toMatchObject({
      content: "今晚想把雨声写进日记。",
      topicSeed: "雨声日记",
      postType: "reflection",
    });
  });

  it("turns a stored post into a chat starter", () => {
    const db = createTestDatabase();
    const post = new FeedPostRepository(db).create({
      userId: "u001",
      agentId: "agent-default",
      agentName: "小伴",
      worldId: "default",
      content: "今天想把海边散步这件事讲给你听。",
      topicSeed: "海边散步",
      postType: "reflection",
      status: "published",
      sourceTaskId: null,
    });

    expect(createPostTrigger({ db, postId: post.id, userId: "u001" })).toEqual({
      postId: post.id,
      userId: "u001",
      agentId: "agent-default",
      suggestedMessage: "我想聊聊你刚才动态里提到的「海边散步」。",
    });
  });
});
