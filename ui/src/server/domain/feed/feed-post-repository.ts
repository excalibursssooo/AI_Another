import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";

export interface FeedPostRecord {
  id: string;
  userId: string;
  agentId: string;
  agentName: string;
  worldId: string;
  content: string;
  topicSeed: string;
  postType: "status" | "reflection" | "plan";
  status: "published" | "archived";
  sourceTaskId: string | null;
  createdAt: number;
}

interface FeedPostRow {
  id: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  world_id: string;
  content: string;
  topic_seed: string;
  post_type: "status" | "reflection" | "plan";
  status: "published" | "archived";
  source_task_id: string | null;
  created_at: number;
}

export class FeedPostRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    userId: string;
    agentId: string;
    agentName: string;
    worldId: string;
    content: string;
    topicSeed: string;
    postType: FeedPostRecord["postType"];
    status: FeedPostRecord["status"];
    sourceTaskId: string | null;
  }): FeedPostRecord {
    const id = `post-${randomUUID()}`;
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO feed_posts
          (id, user_id, agent_id, agent_name, world_id, content, topic_seed, post_type, status, source_task_id, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.agentId,
        input.agentName,
        input.worldId,
        input.content,
        input.topicSeed,
        input.postType,
        input.status,
        input.sourceTaskId,
        now,
      );
    return this.get(id) as FeedPostRecord;
  }

  get(postId: string): FeedPostRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM feed_posts WHERE id = ?").get(postId) as FeedPostRow | undefined;
    return row ? mapFeedPost(row) : null;
  }

  list(input: {
    userId: string;
    worldId?: string;
    limit: number;
    offset: number;
    includeArchived: boolean;
  }): { items: FeedPostRecord[]; total: number } {
    const worldId = input.worldId?.trim() || null;
    const status = input.includeArchived ? null : "published";
    const count = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM feed_posts
         WHERE user_id = ?
           AND (? IS NULL OR world_id = ?)
           AND (? IS NULL OR status = ?)`,
      )
      .get(input.userId, worldId, worldId, status, status) as { count: number };
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM feed_posts
         WHERE user_id = ?
           AND (? IS NULL OR world_id = ?)
           AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC
         LIMIT ?
         OFFSET ?`,
      )
      .all(input.userId, worldId, worldId, status, status, input.limit, input.offset) as FeedPostRow[];
    return {
      items: rows.map(mapFeedPost),
      total: count.count,
    };
  }
}

function mapFeedPost(row: FeedPostRow): FeedPostRecord {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    worldId: row.world_id,
    content: row.content,
    topicSeed: row.topic_seed,
    postType: row.post_type,
    status: row.status,
    sourceTaskId: row.source_task_id,
    createdAt: row.created_at,
  };
}
