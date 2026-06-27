import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@/server/db/client";
import { cosineSimilarity, type EmbeddingResult } from "@/server/ai/embeddings";

export const SHARED_AGENT_ID = "__shared__";
export const TOPIC_MATCH_SIMILARITY = 0.75;
export const TOPIC_RECENT_WINDOW_DAYS = 90;

export function normalizeAgentId(agentId: string | null | undefined): string {
  if (typeof agentId === "string" && agentId.trim()) return agentId;
  return SHARED_AGENT_ID;
}

export interface FeedTopicRecord {
  id: string;
  userId: string;
  worldId: string;
  agentId: string;
  topicKey: string;
  representativeEmbeddingJson: string;
  embeddingModel: string;
  embeddingQuality: string;
  embeddingDimension: number;
  useCount: number;
  firstSeenAt: number;
  lastUsedAt: number;
}

export interface CreateFeedTopicInput {
  userId: string;
  worldId: string;
  agentId: string;
  topicKey: string;
  embedding: EmbeddingResult;
}

export interface ListRecentInput {
  userId: string;
  worldId: string;
  agentId: string;
  sinceDays: number;
}

export interface TopicMatch {
  id: string;
  topicKey: string;
  similarity: number;
}

interface FeedTopicRow {
  id: string; user_id: string; world_id: string; agent_id: string;
  topic_key: string; representative_embedding_json: string;
  embedding_model: string; embedding_quality: string;
  embedding_dimension: number; use_count: number;
  first_seen_at: number; last_used_at: number;
}

function mapRow(row: FeedTopicRow): FeedTopicRecord {
  return {
    id: row.id, userId: row.user_id, worldId: row.world_id, agentId: row.agent_id,
    topicKey: row.topic_key, representativeEmbeddingJson: row.representative_embedding_json,
    embeddingModel: row.embedding_model, embeddingQuality: row.embedding_quality,
    embeddingDimension: row.embedding_dimension, useCount: row.use_count,
    firstSeenAt: row.first_seen_at, lastUsedAt: row.last_used_at,
  };
}

export class FeedTopicRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateFeedTopicInput): string {
    const now = Date.now();
    const id = `topic-${randomUUID()}`;
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO feed_topics
            (id, user_id, world_id, agent_id, topic_key, representative_embedding_json,
             embedding_model, embedding_quality, embedding_dimension,
             use_count, first_seen_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id, input.userId, input.worldId, input.agentId, input.topicKey,
          JSON.stringify(input.embedding.vector),
          input.embedding.model, input.embedding.quality, input.embedding.dimension,
          now, now,
        );
    } catch {
      // UNIQUE conflict — same (user, world, agent, key). Treat as idempotent no-op.
    }
    return input.topicKey;
  }

  listRecent(input: ListRecentInput): FeedTopicRecord[] {
    const sinceMs = Date.now() - input.sinceDays * 86_400_000;
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM feed_topics
         WHERE user_id = ? AND world_id = ? AND agent_id = ?
           AND last_used_at >= ?
         ORDER BY last_used_at DESC`,
      )
      .all(input.userId, input.worldId, input.agentId, sinceMs) as FeedTopicRow[];
    return rows.map(mapRow);
  }

  touch(id: string): void {
    const now = Date.now();
    this.db.sqlite
      .prepare("UPDATE feed_topics SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
      .run(now, id);
  }

  isEmpty(input: { userId: string; worldId: string; agentId: string }): boolean {
    const row = this.db.sqlite
      .prepare("SELECT COUNT(*) AS c FROM feed_topics WHERE user_id = ? AND world_id = ? AND agent_id = ?")
      .get(input.userId, input.worldId, input.agentId) as { c: number };
    return row.c === 0;
  }

  bestMatchByCosine(
    candidates: FeedTopicRecord[],
    queryEmbedding: EmbeddingResult,
    threshold: number,
  ): TopicMatch | null {
    if (queryEmbedding.quality !== "semantic") return null;
    let best: TopicMatch | null = null;
    for (const c of candidates) {
      if (c.embeddingQuality !== "semantic") continue;
      let vec: number[];
      try { vec = JSON.parse(c.representativeEmbeddingJson) as number[]; } catch { continue; }
      const sim = cosineSimilarity(vec, queryEmbedding.vector);
      if (sim === null) continue;
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = { id: c.id, topicKey: c.topicKey, similarity: sim };
      }
    }
    return best;
  }
}
