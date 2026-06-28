import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { VisibilityScope, WorldEventRecord, WorldEventType } from "./types";

interface WorldEventRow {
  id: string;
  decision_id: string;
  world_run_id: string;
  user_id: string;
  world_id: string;
  tick: number;
  sequence: number;
  schema_version: number;
  reducer_version: number;
  type: WorldEventType;
  payload_json: string;
  summary: string;
  visibility: VisibilityScope["mode"];
  visible_to_actor_ids_json: string;
  visible_to_user: number;
  actor_ids_json: string;
  location_key: string | null;
  caused_by_event_id: string | null;
  caused_by_user_action_id: string | null;
  idempotency_key: string;
  status: WorldEventRecord["status"];
  created_at: number;
}

export interface CreateCommittedWorldEventInput {
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  tick: number;
  sequence: number;
  type: WorldEventType;
  payload: unknown;
  summary: string;
  visibility: VisibilityScope;
  actorIds: string[];
  idempotencyKey: string;
  locationKey?: string | null;
  causedByEventId?: string | null;
  causedByUserActionId?: string | null;
  schemaVersion?: number;
  reducerVersion?: number;
}

export class WorldEventRepository {
  constructor(private readonly db: AppDatabase) {}

  allocateNextSequence(input: { userId: string; worldId: string }): number {
    const row = this.db.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM world_events WHERE user_id = ? AND world_id = ?")
      .get(input.userId, input.worldId) as { next_sequence: number };
    return row.next_sequence;
  }

  createCommitted(input: CreateCommittedWorldEventInput): WorldEventRecord {
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const id = `wevt-${randomUUID()}`;
    const now = Date.now();
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO world_events
          (id, decision_id, world_run_id, user_id, world_id, tick, sequence, schema_version, reducer_version,
           type, payload_json, summary, visibility, visible_to_actor_ids_json, visible_to_user, actor_ids_json,
           location_key, caused_by_event_id, caused_by_user_action_id, idempotency_key, status, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
        )
        .run(
          id,
          input.decisionId,
          input.worldRunId,
          input.userId,
          input.worldId,
          input.tick,
          input.sequence,
          input.schemaVersion ?? 1,
          input.reducerVersion ?? 1,
          input.type,
          JSON.stringify(input.payload),
          input.summary,
          input.visibility.mode,
          JSON.stringify(input.visibility.visibleToActorIds),
          input.visibility.visibleToUser ? 1 : 0,
          JSON.stringify(input.actorIds),
          input.locationKey ?? null,
          input.causedByEventId ?? null,
          input.causedByUserActionId ?? null,
          input.idempotencyKey,
          now,
        );
    } catch (error) {
      const idempotentRetry = this.getByIdempotencyKey(input.idempotencyKey);
      if (idempotentRetry) {
        return idempotentRetry;
      }
      throw error;
    }

    const created = this.getById(id);
    if (!created) {
      throw new Error(`Committed world event was not readable after insert: ${id}`);
    }
    return created;
  }

  getById(id: string): WorldEventRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM world_events WHERE id = ?").get(id) as WorldEventRow | undefined;
    return row ? mapWorldEvent(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): WorldEventRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM world_events WHERE idempotency_key = ?")
      .get(idempotencyKey) as WorldEventRow | undefined;
    return row ? mapWorldEvent(row) : null;
  }

  listCommitted(input: { userId: string; worldId: string }): WorldEventRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM world_events
         WHERE user_id = ?
           AND world_id = ?
           AND status = 'committed'
         ORDER BY sequence ASC`,
      )
      .all(input.userId, input.worldId) as WorldEventRow[];
    return rows.map(mapWorldEvent);
  }

  listRecentForWorld(input: { userId: string; worldId: string; limit: number }): WorldEventRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM world_events
         WHERE user_id = ?
           AND world_id = ?
           AND status = 'committed'
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(input.userId, input.worldId, input.limit) as WorldEventRow[];
    // Reverse to get ascending order
    return [...rows].reverse().map(mapWorldEvent);
  }

  listRecentForActor(input: { userId: string; worldId: string; agentId: string; limit: number }): WorldEventRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT *
         FROM world_events
         WHERE user_id = ?
           AND world_id = ?
           AND status = 'committed'
           AND EXISTS (SELECT 1 FROM json_each(actor_ids_json) WHERE value = ?)
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(input.userId, input.worldId, input.agentId, input.limit) as WorldEventRow[];
    // Reverse to get ascending order
    return [...rows].reverse().map(mapWorldEvent);
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapWorldEvent(row: WorldEventRow): WorldEventRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    worldRunId: row.world_run_id,
    userId: row.user_id,
    worldId: row.world_id,
    tick: row.tick,
    sequence: row.sequence,
    schemaVersion: row.schema_version,
    reducerVersion: row.reducer_version,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    summary: row.summary,
    visibility: {
      mode: row.visibility,
      visibleToActorIds: parseJson(row.visible_to_actor_ids_json, []),
      visibleToUser: row.visible_to_user === 1,
    },
    actorIds: parseJson(row.actor_ids_json, []),
    locationKey: row.location_key,
    causedByEventId: row.caused_by_event_id,
    causedByUserActionId: row.caused_by_user_action_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at,
  };
}
