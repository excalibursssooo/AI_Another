import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import type { EmbeddingResult } from "@/server/ai/embeddings";
import { createTestDatabase, type AppDatabase } from "@/server/db/client";
import { FeedTopicRepository, normalizeAgentId, SHARED_AGENT_ID } from "./feed-topic-repository";

const semantic = (vector: number[]): EmbeddingResult => ({
  vector, dimension: vector.length, backend: "llama.cpp",
  quality: "semantic", model: "bge-m3", version: 1, needsRefresh: false,
});

describe("normalizeAgentId", () => {
  it("returns the agent id when non-empty", () => {
    expect(normalizeAgentId("agent-A")).toBe("agent-A");
  });
  it("returns SHARED_AGENT_ID for null / undefined / empty", () => {
    expect(normalizeAgentId(null)).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId(undefined)).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId("")).toBe(SHARED_AGENT_ID);
    expect(normalizeAgentId("   ")).toBe(SHARED_AGENT_ID);
  });
});

describe("FeedTopicRepository", () => {
  let db: AppDatabase;
  let repo: FeedTopicRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new FeedTopicRepository(db);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("create stores a topic and returns the key", () => {
    const key = repo.create({
      userId: "u1", worldId: "w1", agentId: "a1",
      topicKey: "咖啡", embedding: semantic([1, 0, 0]),
    });
    expect(key).toBe("咖啡");
    const list = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    expect(list).toHaveLength(1);
    expect(list[0].useCount).toBe(1);
  });

  it("create is idempotent on UNIQUE conflict (same key)", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    const key = repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    expect(key).toBe("咖啡");
    const list = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    expect(list).toHaveLength(1);
  });

  it("create rethrows non-unique database errors", () => {
    vi.spyOn(db.sqlite, "prepare").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => repo.create({
      userId: "u1", worldId: "w1", agentId: "a1",
      topicKey: "咖啡", embedding: semantic([1, 0, 0]),
    })).toThrow("disk full");
  });

  it("different (user_id, world_id, agent_id) do not collide", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: SHARED_AGENT_ID, topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    repo.create({ userId: "u2", worldId: "w1", agentId: SHARED_AGENT_ID, topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: SHARED_AGENT_ID, sinceDays: 90 })).toHaveLength(1);
    expect(repo.listRecent({ userId: "u2", worldId: "w1", agentId: SHARED_AGENT_ID, sinceDays: 90 })).toHaveLength(1);
  });

  it("touch increments use_count and updates last_used_at", async () => {
    const key = repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    void key;
    const before = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })[0];
    await new Promise((r) => setTimeout(r, 5));
    repo.touch(before.id);
    const after = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })[0];
    expect(after.useCount).toBe(before.useCount + 1);
    expect(after.lastUsedAt).toBeGreaterThanOrEqual(before.lastUsedAt);
  });

  it("bestMatchByCosine returns highest-similarity match above threshold", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "加班", embedding: semantic([0, 1, 0]) });
    const candidates = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    const match = repo.bestMatchByCosine(candidates, semantic([0.99, 0.01, 0]), 0.7);
    expect(match?.topicKey).toBe("咖啡");
    expect(match?.similarity).toBeGreaterThan(0.9);
  });

  it("bestMatchByCosine returns null when no candidate meets threshold", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0, 0]) });
    const candidates = repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 });
    const match = repo.bestMatchByCosine(candidates, semantic([0, 0, 1]), 0.9);
    expect(match).toBeNull();
  });

  it("isEmpty reflects table state", () => {
    expect(repo.isEmpty({ userId: "u1", worldId: "w1", agentId: "a1" })).toBe(true);
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    expect(repo.isEmpty({ userId: "u1", worldId: "w1", agentId: "a1" })).toBe(false);
  });

  it("sinceDays filters out old rows", () => {
    repo.create({ userId: "u1", worldId: "w1", agentId: "a1", topicKey: "咖啡", embedding: semantic([1, 0]) });
    const oneHundredDaysAgo = Date.now() - 100 * 86_400_000;
    db.sqlite.prepare("UPDATE feed_topics SET last_used_at = ?").run(oneHundredDaysAgo);
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 90 })).toHaveLength(0);
    expect(repo.listRecent({ userId: "u1", worldId: "w1", agentId: "a1", sinceDays: 365 })).toHaveLength(1);
  });
});
