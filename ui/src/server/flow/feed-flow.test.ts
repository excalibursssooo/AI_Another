import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ConversationRepository, FeedPostRepository } from "@/server/domain/chat/repositories";
import { createFeedGenerateFlow, createPostTrigger } from "./feed-flow";
import { extractTopicWithCluster } from "./feed-flow";
import { SHARED_AGENT_ID } from "@/server/domain/chat/feed-topic-repository";
import type { EmbedText } from "@/server/domain/chat/memory-consolidator";
import * as feedModule from "./feed-flow";

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
    expect(result.post?.content).toContain("海边散");
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

describe("extractTopicWithCluster", () => {
  // Semantic embeddings that are very similar to each other for clustering tests
  const makeSemanticEmbed = (extra: number): EmbedText => async () => ({
    vector: [0.1 + extra * 0.01, 0.2 + extra * 0.01, 0.3, 0.4],
    dimension: 4,
    backend: "llama.cpp",
    quality: "semantic",
    model: "bge-m3",
    version: 1,
    needsRefresh: false,
  });

  it("clusters similar fallback contents to the same topic key", async () => {
    const db = createTestDatabase();
    const embed = makeSemanticEmbed(0);
    const k1 = await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1", embedText: embed });
    const k2 = await extractTopicWithCluster({ db, content: "刚泡了咖啡", userId: "u1", agentId: "a1", worldId: "w1", embedText: makeSemanticEmbed(1) });
    const k3 = await extractTopicWithCluster({ db, content: "咖啡真好喝", userId: "u1", agentId: "a1", worldId: "w1", embedText: makeSemanticEmbed(2) });
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("isolates topics per (user_id, world_id, agent_id)", async () => {
    const db = createTestDatabase();
    const embed = makeSemanticEmbed(0);
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1", embedText: embed });
    const k2 = await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u2", agentId: "a1", worldId: "w1", embedText: makeSemanticEmbed(1) });
    const row = db.sqlite.prepare("SELECT COUNT(*) AS c FROM feed_topics").get() as { c: number };
    expect(row.c).toBe(2);
    expect(typeof k2).toBe("string");
  });

  it("uses __shared__ sentinel when agentId is null", async () => {
    const db = createTestDatabase();
    const embed = makeSemanticEmbed(0);
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: null, worldId: "w1", embedText: embed });
    const row = db.sqlite.prepare("SELECT agent_id FROM feed_topics LIMIT 1").get() as { agent_id: string };
    expect(row.agent_id).toBe(SHARED_AGENT_ID);
  });

  it("logs topic_fallback with cold_start reason on first call", async () => {
    const db = createTestDatabase();
    const embed = makeSemanticEmbed(0);
    await extractTopicWithCluster({ db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1", embedText: embed });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'topic_fallback'").all() as Array<{ reason: string }>;
    expect(rows.map((r) => r.reason)).toContain("cold_start");
  });

  it("logs topic_fallback with embedding_unavailable when embedding is fallback", async () => {
    const db = createTestDatabase();
    const fakeEmbed: EmbedText = async () => ({
      vector: [0.1, 0.2], dimension: 2, backend: "fallback", quality: "lexical",
      model: "fallback-hash-v1", version: 1, needsRefresh: true,
      fallbackReason: "fetch_failed",
    });
    await extractTopicWithCluster({
      db, content: "今天喝了咖啡", userId: "u1", agentId: "a1", worldId: "w1",
      embedText: fakeEmbed,
    });
    const rows = db.sqlite.prepare("SELECT * FROM memory_operation_logs WHERE kind = 'topic_fallback'").all() as Array<{ reason: string }>;
    expect(rows.map((r) => r.reason)).toContain("embedding_unavailable");
  });
});

describe("GenerateFeedPost LLM-success path", () => {
  it("does not call extractTopicWithCluster when generateFeedPostDraft returns a draft", async () => {
    const db = createTestDatabase();
    const extractSpy = vi.spyOn(feedModule, "extractTopicWithCluster");
    const flow = createFeedGenerateFlow({
      db,
      generateFeedPostDraft: async () => ({
        content: "今天喝了咖啡。",
        topicSeed: "咖啡",
        postType: "status",
      }),
    });
    const result = await flow.run({ userId: "u001", agentId: "agent-default", worldId: "default" });
    expect(extractSpy).not.toHaveBeenCalled();
    expect(result.topicSeed).toBe("咖啡");
  });
});
