import { randomUUID } from "node:crypto";

import { AppDatabase } from "@/server/db/client";

export interface AgentRecord {
  id: string;
  name: string;
  displayName: string;
  persona: string;
  background: string;
  greeting: string;
  speakingStyle: string;
  hobbies: string[];
  worldId: string;
  status: "active" | "inactive";
  createdAt: number;
  updatedAt: number;
}

export interface WorldRecord {
  id: string;
  name: string;
  lore: string;
  tone: string;
  constraints: string[];
  seedMemories: string[];
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number;
}

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

export interface AgentLiveStateRecord {
  agentId: string;
  userId: string;
  agentName: string;
  moodLabel: string;
  moodIntensity: number;
  heartbeatBpm: number;
  riskLevel: string;
  updatedAt: number;
}

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

interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  persona: string;
  background: string;
  greeting: string;
  speaking_style: string;
  hobbies_json: string;
  world_id: string;
  status: "active" | "inactive";
  created_at: number;
  updated_at: number;
}

interface WorldRow {
  id: string;
  name: string;
  lore: string;
  tone: string;
  constraints_json: string;
  seed_memories_json: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: number;
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

export class AgentRepository {
  constructor(private readonly db: AppDatabase) {}

  listActive(worldId?: string): AgentRecord[] {
    const rows = this.db.sqlite
      .prepare(
        worldId
          ? "SELECT * FROM agents WHERE status = 'active' AND world_id = ? ORDER BY updated_at DESC"
          : "SELECT * FROM agents WHERE status = 'active' ORDER BY updated_at DESC",
      )
      .all(...(worldId ? [worldId] : [])) as AgentRow[];
    return rows.map(mapAgent);
  }

  get(agentId: string): AgentRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  create(input: {
    name: string;
    displayName?: string;
    persona: string;
    background: string;
    greeting?: string;
    speakingStyle: string;
    hobbies: string[];
    worldId: string;
  }): AgentRecord {
    const now = Date.now();
    const id = `agent-${randomUUID()}`;
    const displayName = input.displayName ?? input.name;
    this.db.sqlite
      .prepare(
        `INSERT INTO agents
          (id, name, display_name, persona, background, greeting, speaking_style, hobbies_json, world_id, status, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.name,
        displayName,
        input.persona,
        input.background,
        input.greeting ?? `你好，我是${displayName}。`,
        input.speakingStyle,
        JSON.stringify(input.hobbies),
        input.worldId,
        now,
        now,
      );
    return this.get(id) as AgentRecord;
  }

  update(agentId: string, input: Partial<Omit<AgentRecord, "id" | "createdAt" | "updatedAt">>): AgentRecord | null {
    const current = this.get(agentId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...input };
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `UPDATE agents
         SET name = ?,
             display_name = ?,
             persona = ?,
             background = ?,
             greeting = ?,
             speaking_style = ?,
             hobbies_json = ?,
             world_id = ?,
             status = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.displayName,
        next.persona,
        next.background,
        next.greeting,
        next.speakingStyle,
        JSON.stringify(next.hobbies),
        next.worldId,
        next.status,
        now,
        agentId,
      );
    return this.get(agentId);
  }

  deactivate(agentId: string): AgentRecord | null {
    if (agentId === "agent-default") {
      return null;
    }
    return this.update(agentId, { status: "inactive" });
  }
}

export class WorldRepository {
  constructor(private readonly db: AppDatabase) {}

  list(): WorldRecord[] {
    const rows = this.db.sqlite.prepare("SELECT * FROM worlds ORDER BY updated_at DESC").all() as WorldRow[];
    return rows.map(mapWorld);
  }

  get(worldId: string): WorldRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM worlds WHERE id = ?").get(worldId) as WorldRow | undefined;
    return row ? mapWorld(row) : null;
  }

  upsert(input: WorldRecord): WorldRecord {
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO worlds
          (id, name, lore, tone, constraints_json, seed_memories_json, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           lore = excluded.lore,
           tone = excluded.tone,
           constraints_json = excluded.constraints_json,
           seed_memories_json = excluded.seed_memories_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.lore,
        input.tone,
        JSON.stringify(input.constraints),
        JSON.stringify(input.seedMemories),
        now,
        now,
      );
    return this.get(input.id) as WorldRecord;
  }
}

export class ConversationRepository {
  constructor(private readonly db: AppDatabase) {}

  ensureConversation(input: { userId: string; agentId: string; worldId: string }): string {
    const existing = this.db.sqlite
      .prepare("SELECT id FROM conversations WHERE user_id = ? AND agent_id = ? AND world_id = ?")
      .get(input.userId, input.agentId, input.worldId) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const id = `conv-${randomUUID()}`;
    this.db.sqlite
      .prepare(
        `INSERT INTO conversations (id, user_id, agent_id, world_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.agentId, input.worldId, now, now);
    return id;
  }

  appendMessage(input: {
    conversationId: string;
    role: ConversationMessageRecord["role"];
    content: string;
    metadataJson?: string;
  }): ConversationMessageRecord {
    const now = Date.now();
    const message: ConversationMessageRecord = {
      id: `msg-${randomUUID()}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: now,
    };
    this.db.sqlite
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.conversationId, message.role, message.content, input.metadataJson ?? "{}", now);
    this.db.sqlite
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, input.conversationId);
    return message;
  }

  recentMessages(conversationId: string, limit: number): ConversationMessageRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT id, conversation_id, role, content, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.reverse().map(mapMessage);
  }

  recentMessagesForScope(input: { userId: string; agentId: string; worldId?: string; limit: number }): ConversationMessageRecord[] {
    const row = this.db.sqlite
      .prepare(
        `SELECT id
         FROM conversations
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
         LIMIT 1`,
      )
      .get(input.userId, input.agentId, input.worldId ?? "default") as { id: string } | undefined;
    return row ? this.recentMessages(row.id, input.limit) : [];
  }
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

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    persona: row.persona,
    background: row.background,
    greeting: row.greeting,
    speakingStyle: row.speaking_style,
    hobbies: parseStringArray(row.hobbies_json),
    worldId: row.world_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorld(row: WorldRow): WorldRecord {
  return {
    id: row.id,
    name: row.name,
    lore: row.lore,
    tone: row.tone,
    constraints: parseStringArray(row.constraints_json),
    seedMemories: parseStringArray(row.seed_memories_json),
  };
}

function mapMessage(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
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

export class AgentLiveStateRepository {
  constructor(private readonly db: AppDatabase) {}

  upsert(input: AgentLiveStateRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO agent_live_states
         (agent_id, user_id, agent_name, mood_label, mood_intensity, heartbeat_bpm, risk_level, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, agent_id) DO UPDATE SET
           agent_name = excluded.agent_name,
           mood_label = excluded.mood_label,
           mood_intensity = excluded.mood_intensity,
           heartbeat_bpm = excluded.heartbeat_bpm,
           risk_level = excluded.risk_level,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        input.userId,
        input.agentName,
        input.moodLabel,
        input.moodIntensity,
        input.heartbeatBpm,
        input.riskLevel,
        input.updatedAt,
      );
  }

  get(userId: string, agentId: string, fallbackName: string): AgentLiveStateRecord {
    const row = this.db.sqlite
      .prepare("SELECT * FROM agent_live_states WHERE user_id = ? AND agent_id = ?")
      .get(userId, agentId) as
      | {
          agent_id: string;
          user_id: string;
          agent_name: string;
          mood_label: string;
          mood_intensity: number;
          heartbeat_bpm: number;
          risk_level: string;
          updated_at: number;
        }
      | undefined;
    if (row) {
      return {
        agentId: row.agent_id,
        userId: row.user_id,
        agentName: row.agent_name,
        moodLabel: row.mood_label,
        moodIntensity: row.mood_intensity,
        heartbeatBpm: row.heartbeat_bpm,
        riskLevel: row.risk_level,
        updatedAt: row.updated_at,
      };
    }
    return {
      agentId,
      userId,
      agentName: fallbackName,
      moodLabel: "calm",
      moodIntensity: 0.35,
      heartbeatBpm: 72,
      riskLevel: "low",
      updatedAt: Date.now(),
    };
  }
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

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
