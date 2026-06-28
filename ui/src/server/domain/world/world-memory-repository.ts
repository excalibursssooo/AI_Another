import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { CreateWorldMemoryInput, WorldMemoryRecord, WorldMemoryVisibility } from "./types";

interface WorldMemoryRow {
  id: string;
  user_id: string;
  world_id: string;
  subject_type: string;
  subject_key: string;
  memory_type: string;
  canonical_key: string | null;
  content: string;
  visibility: WorldMemoryVisibility;
  visible_to_actor_ids_json: string;
  visible_to_user: number;
  importance: number;
  confidence: number;
  valid_from_tick: number;
  source_event_id: string | null;
  source_decision_id: string | null;
  superseded_by: string | null;
  embedding_json: string | null;
  embedding_quality: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function mapWorldMemory(row: WorldMemoryRow): WorldMemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    worldId: row.world_id,
    subjectType: row.subject_type,
    subjectKey: row.subject_key,
    memoryType: row.memory_type,
    canonicalKey: row.canonical_key,
    content: row.content,
    visibility: row.visibility,
    visibleToActorIds: parseJson(row.visible_to_actor_ids_json, []),
    visibleToUser: row.visible_to_user === 1,
    importance: row.importance,
    confidence: row.confidence,
    validFromTick: row.valid_from_tick,
    sourceEventId: row.source_event_id,
    sourceDecisionId: row.source_decision_id,
    supersededBy: row.superseded_by,
    embeddingJson: row.embedding_json,
    embeddingQuality: row.embedding_quality,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorldMemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateWorldMemoryInput): WorldMemoryRecord {
    // Non-lore memories require a sourceEventId
    if (input.memoryType !== "lore" && input.sourceEventId == null) {
      throw new Error("sourceEventId is required for non-lore memory");
    }

    const id = `wmem-${randomUUID()}`;
    const now = Date.now();

    this.db.sqlite
      .prepare(
        `INSERT INTO world_memories
          (id, user_id, world_id, subject_type, subject_key, memory_type, canonical_key, content,
           visibility, visible_to_actor_ids_json, visible_to_user, importance, confidence,
           valid_from_tick, source_event_id, source_decision_id, superseded_by,
           embedding_json, embedding_quality, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.worldId,
        input.subjectType,
        input.subjectKey,
        input.memoryType,
        input.canonicalKey ?? null,
        input.content,
        input.visibility,
        stringifyJson(input.visibleToActorIds),
        input.visibleToUser ? 1 : 0,
        input.importance,
        input.confidence,
        input.validFromTick,
        input.sourceEventId ?? null,
        input.sourceDecisionId ?? null,
        input.supersededBy ?? null,
        input.embeddingJson ?? null,
        input.embeddingQuality ?? null,
        now,
        now,
      );

    const created = this.getById(id);
    if (!created) {
      throw new Error(`WorldMemory was not readable after insert: ${id}`);
    }
    return created;
  }

  recallForDirector(input: {
    userId: string;
    worldId: string;
    subjectType: string;
    subjectKey?: string;
  }): WorldMemoryRecord[] {
    const base_sql = `SELECT * FROM world_memories
      WHERE user_id = ? AND world_id = ? AND subject_type = ? AND superseded_by IS NULL`;
    const params: (string | number)[] = [input.userId, input.worldId, input.subjectType];

    if (input.subjectKey !== undefined) {
      const rows = this.db.sqlite
        .prepare(`${base_sql} AND subject_key = ? ORDER BY valid_from_tick DESC, created_at DESC`)
        .all(...params, input.subjectKey) as WorldMemoryRow[];
      return rows.map(mapWorldMemory);
    }

    const rows = this.db.sqlite
      .prepare(`${base_sql} ORDER BY valid_from_tick DESC, created_at DESC`)
      .all(...params) as WorldMemoryRow[];
    return rows.map(mapWorldMemory);
  }

  recallForActor(input: {
    userId: string;
    worldId: string;
    agentId: string;
    subjectType: string;
    subjectKey?: string;
  }): WorldMemoryRecord[] {
    const base_sql = `SELECT * FROM world_memories
      WHERE user_id = ? AND world_id = ? AND subject_type = ? AND superseded_by IS NULL
        AND (
          visibility = 'public'
          OR visibility = 'private'
          OR (? IN (SELECT value FROM json_each(visible_to_actor_ids_json)))
        )`;
    const params: (string | number)[] = [input.userId, input.worldId, input.subjectType, input.agentId];

    if (input.subjectKey !== undefined) {
      const rows = this.db.sqlite
        .prepare(`${base_sql} AND subject_key = ? ORDER BY valid_from_tick DESC, created_at DESC`)
        .all(...params, input.subjectKey) as WorldMemoryRow[];
      return rows.map(mapWorldMemory);
    }

    const rows = this.db.sqlite
      .prepare(`${base_sql} ORDER BY valid_from_tick DESC, created_at DESC`)
      .all(...params) as WorldMemoryRow[];
    return rows.map(mapWorldMemory);
  }

  private getById(id: string): WorldMemoryRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM world_memories WHERE id = ?").get(id) as WorldMemoryRow | undefined;
    return row ? mapWorldMemory(row) : null;
  }
}
