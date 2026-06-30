import { randomUUID } from "node:crypto";

import { AppDatabase } from "@/server/db/client";

export type { AgentRecord } from "@/server/domain/agent/agent-repository";
export { AgentRepository } from "@/server/domain/agent/agent-repository";
export type { WorldRecord } from "@/server/domain/world/world-repository";
export { WorldRepository } from "@/server/domain/world/world-repository";
export type { ConversationMessageRecord } from "@/server/domain/conversation/conversation-repository";
export { ConversationRepository } from "@/server/domain/conversation/conversation-repository";
export type { AgentLiveStateRecord } from "@/server/domain/live-state/agent-live-state-repository";
export { AgentLiveStateRepository } from "@/server/domain/live-state/agent-live-state-repository";
export type { FeedPostRecord } from "@/server/domain/feed/feed-post-repository";
export { FeedPostRepository } from "@/server/domain/feed/feed-post-repository";

export interface MemoryRecord {
  id: string;
  userId: string;
  agentId: string;
  worldId: string;
  subject: string;
  memoryType: string;
  content: string;
  importance: number;
  confidence: number;
  status: "active" | "frozen" | "deleted";
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number | null;
  key: string | null;
  topic: string | null;
  embeddingJson: string | null;
  embeddingModel: string | null;
  embeddingBackend: string | null;
  embeddingQuality: string | null;
  embeddingDimension: number | null;
  embeddingStatus: "missing" | "ready" | "fallback" | "stale" | "failed";
  embeddingTextHash: string | null;
  embeddingVersion: number;
  embeddingNeedsRefresh: boolean;
  embeddingUpdatedAt: number | null;
  supersededBy: string | null;
  supersededReason: string | null;
  lastObservedAt: number | null;
  sourceMessageId: string | null;
  sourceTaskId: string | null;
}

interface MemoryRow {
  id: string;
  user_id: string;
  agent_id: string;
  world_id: string;
  subject: string;
  memory_type: string;
  content: string;
  importance: number;
  confidence: number;
  status: "active" | "frozen" | "deleted";
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number | null;
  canonical_key: string | null;
  topic: string | null;
  embedding_json: string | null;
  embedding_model: string | null;
  embedding_backend: string | null;
  embedding_quality: string | null;
  embedding_dimension: number | null;
  embedding_status: "missing" | "ready" | "fallback" | "stale" | "failed";
  embedding_text_hash: string | null;
  embedding_version: number;
  embedding_needs_refresh: number;
  embedding_updated_at: number | null;
  superseded_by: string | null;
  superseded_reason: string | null;
  last_observed_at: number | null;
  source_message_id: string | null;
  source_task_id: string | null;
}

interface MemoryEmbeddingInput {
  json: string;
  model: string;
  backend: string;
  quality: string;
  dimension: number;
  status: "missing" | "ready" | "fallback" | "stale" | "failed";
  textHash: string;
  version: number;
  needsRefresh: boolean;
  updatedAt: number;
}

interface CreateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  subject: string;
  memoryType: string;
  key?: string | null;
  topic?: string | null;
  content: string;
  importance: number;
  confidence: number;
  embedding?: MemoryEmbeddingInput;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  lastObservedAt?: number | null;
}

export class MemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateMemoryInput): MemoryRecord {
    const now = Date.now();
    const id = `mem-${randomUUID()}`;
    const emb = input.embedding;
    this.db.sqlite
      .prepare(
        `INSERT INTO memories
          (id, user_id, agent_id, world_id, subject, memory_type, canonical_key, topic, content, importance, confidence,
           embedding_json, embedding_model, embedding_backend, embedding_quality, embedding_dimension,
           embedding_status, embedding_text_hash, embedding_version, embedding_needs_refresh, embedding_updated_at,
           source_message_id, source_task_id, last_observed_at, status, created_at, updated_at, access_count, last_accessed_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.agentId,
        input.worldId,
        input.subject,
        input.memoryType,
        input.key ?? null,
        input.topic ?? null,
        input.content,
        input.importance,
        input.confidence,
        emb?.json ?? null,
        emb?.model ?? null,
        emb?.backend ?? null,
        emb?.quality ?? null,
        emb?.dimension ?? null,
        emb?.status ?? "missing",
        emb?.textHash ?? null,
        emb?.version ?? 1,
        emb?.needsRefresh ? 1 : 0,
        emb?.updatedAt ?? null,
        input.sourceMessageId ?? null,
        input.sourceTaskId ?? null,
        input.lastObservedAt ?? null,
        "active",
        now,
        now,
        0,
        null,
      );
    return {
      id,
      userId: input.userId,
      agentId: input.agentId,
      worldId: input.worldId,
      subject: input.subject,
      memoryType: input.memoryType,
      content: input.content,
      importance: input.importance,
      confidence: input.confidence,
      status: "active",
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: null,
      key: input.key ?? null,
      topic: input.topic ?? null,
      embeddingJson: emb?.json ?? null,
      embeddingModel: emb?.model ?? null,
      embeddingBackend: emb?.backend ?? null,
      embeddingQuality: emb?.quality ?? null,
      embeddingDimension: emb?.dimension ?? null,
      embeddingStatus: emb?.status ?? "missing",
      embeddingTextHash: emb?.textHash ?? null,
      embeddingVersion: emb?.version ?? 1,
      embeddingNeedsRefresh: emb?.needsRefresh ?? false,
      embeddingUpdatedAt: emb?.updatedAt ?? null,
      supersededBy: null,
      supersededReason: null,
      lastObservedAt: input.lastObservedAt ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
    };
  }

  recall(input: { userId: string; agentId: string; worldId: string; query: string; limit: number }): MemoryRecord[] {
    const query = input.query.trim();
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM memories
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
           AND status = 'active'
         ORDER BY updated_at DESC`,
      )
      .all(input.userId, input.agentId, input.worldId) as MemoryRow[];
    const ftsMatches = query ? this.matchFtsIds(query) : new Set<string>();
    const scored = rows
      .map((row) => ({ row, score: scoreMemory(row, query, ftsMatches.has(row.id)) }))
      .filter((item) => !query || item.score.textScore > 0)
      .sort(
        (a, b) =>
          b.score.total - a.score.total || b.row.importance - a.row.importance || b.row.updated_at - a.row.updated_at,
      )
      .slice(0, Math.max(0, input.limit));
    this.touchAccess(scored.map((item) => item.row.id));
    return scored.map((item) => mapMemory(item.row));
  }

  touchAccess(memoryIds: string[]): void {
    const uniqueIds = [...new Set(memoryIds.filter((id) => id.trim()))];
    if (uniqueIds.length === 0) {
      return;
    }
    const now = Date.now();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db.sqlite
      .prepare(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?,
             updated_at = updated_at
         WHERE id IN (${placeholders})`,
      )
      .run(now, ...uniqueIds);
  }

  private matchFtsIds(query: string): Set<string> {
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => term.replace(/["*]/g, "").trim())
      .filter(Boolean);
    if (terms.length === 0) {
      return new Set();
    }
    const matchQuery = terms.map((term) => `"${term}"*`).join(" OR ");
    try {
      const rows = this.db.sqlite
        .prepare(
          `SELECT m.id
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ?`,
        )
        .all(matchQuery) as Array<{ id: string }>;
      return new Set(rows.map((row) => row.id));
    } catch {
      return new Set();
    }
  }

  list(input: { userId: string; agentId: string; worldId: string; status?: string }): MemoryRecord[] {
    const status = input.status && input.status !== "all" ? input.status : null;
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM memories
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
           AND (? IS NULL OR status = ?)
         ORDER BY updated_at DESC`,
      )
      .all(input.userId, input.agentId, input.worldId, status, status) as MemoryRow[];
    return rows.map(mapMemory);
  }

  setStatus(input: {
    userId: string;
    agentId: string;
    worldId: string;
    memoryId: string;
    status: MemoryRecord["status"];
  }): MemoryRecord | null {
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `UPDATE memories
         SET status = ?,
             updated_at = ?
         WHERE id = ?
           AND user_id = ?
           AND agent_id = ?
           AND world_id = ?`,
      )
      .run(input.status, now, input.memoryId, input.userId, input.agentId, input.worldId);
    const row = this.db.sqlite
      .prepare(
        `SELECT *
         FROM memories
         WHERE id = ?
           AND user_id = ?
           AND agent_id = ?
           AND world_id = ?`,
      )
      .get(input.memoryId, input.userId, input.agentId, input.worldId) as MemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  listActiveForScope(input: { userId: string; agentId: string; worldId: string }): MemoryRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM memories
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
           AND status = 'active'
         ORDER BY updated_at DESC`,
      )
      .all(input.userId, input.agentId, input.worldId) as MemoryRow[];
    return rows.map(mapMemory);
  }

  mergeMemory(input: {
    memoryId: string;
    content?: string;
    importance?: number;
    confidence?: number;
    key?: string | null;
    topic?: string | null;
    embedding?: MemoryEmbeddingInput;
    lastObservedAt?: number | null;
  }): MemoryRecord | null {
    const result = this.db.sqlite.transaction(() => {
      const now = Date.now();
      const emb = input.embedding;
      this.db.sqlite
        .prepare(
          `UPDATE memories
           SET content = COALESCE(?, content),
               importance = COALESCE(?, importance),
               confidence = COALESCE(?, confidence),
               canonical_key = COALESCE(?, canonical_key),
               topic = COALESCE(?, topic),
               embedding_json = COALESCE(?, embedding_json),
               embedding_model = COALESCE(?, embedding_model),
               embedding_backend = COALESCE(?, embedding_backend),
               embedding_quality = COALESCE(?, embedding_quality),
               embedding_dimension = COALESCE(?, embedding_dimension),
               embedding_status = COALESCE(?, embedding_status),
               embedding_text_hash = COALESCE(?, embedding_text_hash),
               embedding_version = COALESCE(?, embedding_version),
               embedding_needs_refresh = COALESCE(?, embedding_needs_refresh),
               embedding_updated_at = COALESCE(?, embedding_updated_at),
               last_observed_at = COALESCE(?, last_observed_at),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.content ?? null,
          input.importance ?? null,
          input.confidence ?? null,
          input.key ?? null,
          input.topic ?? null,
          emb?.json ?? null,
          emb?.model ?? null,
          emb?.backend ?? null,
          emb?.quality ?? null,
          emb?.dimension ?? null,
          emb?.status ?? null,
          emb?.textHash ?? null,
          emb?.version ?? null,
          emb?.needsRefresh != null ? (emb.needsRefresh ? 1 : 0) : null,
          emb?.updatedAt ?? null,
          input.lastObservedAt ?? null,
          now,
          input.memoryId,
        );
      const row = this.db.sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(input.memoryId) as MemoryRow | undefined;
      return row ? mapMemory(row) : null;
    })();
    return result;
  }

  replaceConflicted(input: {
    oldMemoryId: string;
    reason: string;
    newMemory: {
      userId: string;
      agentId: string;
      worldId: string;
      subject: string;
      memoryType: string;
      key?: string | null;
      topic?: string | null;
      content: string;
      importance: number;
      confidence: number;
      embedding?: MemoryEmbeddingInput;
      sourceMessageId?: string | null;
      sourceTaskId?: string | null;
      lastObservedAt?: number | null;
    };
  }): MemoryRecord {
    const result = this.db.sqlite.transaction(() => {
      const now = Date.now();
      const newId = `mem-${randomUUID()}`;
      const emb = input.newMemory.embedding;
      this.db.sqlite
        .prepare(
          `INSERT INTO memories
            (id, user_id, agent_id, world_id, subject, memory_type, canonical_key, topic, content, importance, confidence,
             embedding_json, embedding_model, embedding_backend, embedding_quality, embedding_dimension,
             embedding_status, embedding_text_hash, embedding_version, embedding_needs_refresh, embedding_updated_at,
             source_message_id, source_task_id, last_observed_at, status, created_at, updated_at, access_count, last_accessed_at)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?)`,
        )
        .run(
          newId,
          input.newMemory.userId,
          input.newMemory.agentId,
          input.newMemory.worldId,
          input.newMemory.subject,
          input.newMemory.memoryType,
          input.newMemory.key ?? null,
          input.newMemory.topic ?? null,
          input.newMemory.content,
          input.newMemory.importance,
          input.newMemory.confidence,
          emb?.json ?? null,
          emb?.model ?? null,
          emb?.backend ?? null,
          emb?.quality ?? null,
          emb?.dimension ?? null,
          emb?.status ?? "missing",
          emb?.textHash ?? null,
          emb?.version ?? 1,
          emb?.needsRefresh ? 1 : 0,
          emb?.updatedAt ?? null,
          input.newMemory.sourceMessageId ?? null,
          input.newMemory.sourceTaskId ?? null,
          input.newMemory.lastObservedAt ?? null,
          now,
          now,
          null,
        );
      this.db.sqlite
        .prepare(
          `UPDATE memories
           SET status = 'frozen',
               superseded_by = ?,
               superseded_reason = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(newId, input.reason, now, input.oldMemoryId);
      const row = this.db.sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(newId) as MemoryRow;
      return mapMemory(row);
    })();
    return result;
  }
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    worldId: row.world_id,
    subject: row.subject,
    memoryType: row.memory_type,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    key: row.canonical_key,
    topic: row.topic,
    embeddingJson: row.embedding_json,
    embeddingModel: row.embedding_model,
    embeddingBackend: row.embedding_backend,
    embeddingQuality: row.embedding_quality,
    embeddingDimension: row.embedding_dimension,
    embeddingStatus: row.embedding_status,
    embeddingTextHash: row.embedding_text_hash,
    embeddingVersion: row.embedding_version,
    embeddingNeedsRefresh: row.embedding_needs_refresh === 1,
    embeddingUpdatedAt: row.embedding_updated_at,
    supersededBy: row.superseded_by,
    supersededReason: row.superseded_reason,
    lastObservedAt: row.last_observed_at,
    sourceMessageId: row.source_message_id,
    sourceTaskId: row.source_task_id,
  };
}

function scoreMemory(
  row: MemoryRow,
  query: string,
  ftsMatched: boolean,
): { total: number; textScore: number; recency: number; relationshipBoost: number } {
  const textScore = computeTextScore(row.content, query, ftsMatched);
  const ageMs = Math.max(0, Date.now() - row.updated_at);
  const ageDays = ageMs / 86_400_000;
  const recency = 1 / (1 + ageDays / 30);
  const relationshipBoost = row.memory_type === "relationship" ? 1 : row.subject === "user" ? 0.7 : 0.4;
  return {
    textScore,
    recency,
    relationshipBoost,
    total: textScore * 0.45 + row.importance * 0.25 + recency * 0.15 + relationshipBoost * 0.15,
  };
}

function computeTextScore(content: string, query: string, ftsMatched: boolean): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 1;
  }
  const normalizedContent = content.toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  let occurrences = 0;
  for (const term of terms) {
    occurrences += countOccurrences(normalizedContent, term);
  }
  if (occurrences > 0) {
    return Math.min(1, occurrences / 3);
  }
  return ftsMatched ? 0.6 : 0;
}

function countOccurrences(content: string, term: string): number {
  if (!term) {
    return 0;
  }
  let count = 0;
  let index = content.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(term, index + term.length);
  }
  return count;
}
