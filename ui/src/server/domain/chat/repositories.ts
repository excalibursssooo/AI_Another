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
  access_count: number;
  last_accessed_at: number | null;
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

export class MemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    userId: string;
    agentId: string;
    worldId: string;
    subject: string;
    memoryType: string;
    content: string;
    importance: number;
    confidence: number;
  }): MemoryRecord {
    const now = Date.now();
    const id = `mem-${randomUUID()}`;
    this.db.sqlite
      .prepare(
        `INSERT INTO memories
          (id, user_id, agent_id, world_id, subject, memory_type, content, importance, confidence, status, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.agentId,
        input.worldId,
        input.subject,
        input.memoryType,
        input.content,
        input.importance,
        input.confidence,
        now,
        now,
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
    };
  }

  recall(input: { userId: string; agentId: string; worldId: string; query: string; limit: number }): MemoryRecord[] {
    const query = `%${input.query.trim()}%`;
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM memories
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
           AND status = 'active'
           AND (? = '%%' OR content LIKE ?)
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(input.userId, input.agentId, input.worldId, query, query, input.limit) as MemoryRow[];
    return rows.map(mapMemory);
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
  };
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
         ON CONFLICT(agent_id) DO UPDATE SET
           user_id = excluded.user_id,
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

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
