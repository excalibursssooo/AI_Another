import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { WorldRunEnvelope, WorldRunSourceType, WorldRunStatus } from "./types";

interface WorldRunRow {
  id: string;
  idempotency_key: string;
  user_id: string;
  world_id: string;
  source_type: WorldRunSourceType;
  source_action_id: string;
  decision_id: string;
  agent_id: string | null;
  status: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateWorldRunInput {
  userId: string;
  worldId: string;
  agentId?: string;
  sourceType: WorldRunSourceType;
  sourceActionId: string;
  idempotencyKey: string;
}

export class WorldRunRepository {
  constructor(private readonly db: AppDatabase) {}

  createOrGet(input: CreateWorldRunInput): WorldRunEnvelope {
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const worldRunId = `wrun-${randomUUID()}`;
    const decisionId = `wdec-${randomUUID()}`;
    const now = Date.now();

    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO world_runs
            (id, idempotency_key, user_id, world_id, source_type, source_action_id, decision_id, agent_id, status, created_at, updated_at)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          worldRunId,
          input.idempotencyKey,
          input.userId,
          input.worldId,
          input.sourceType,
          input.sourceActionId,
          decisionId,
          input.agentId ?? null,
          now,
          now,
        );
    } catch (error) {
      const retry = this.getByIdempotencyKey(input.idempotencyKey);
      if (retry) {
        return retry;
      }
      throw error;
    }

    const created = this.getById(worldRunId);
    if (!created) {
      throw new Error(`World run was not readable after insert: ${worldRunId}`);
    }
    return created;
  }

  markCommitted(input: { worldRunId: string; result?: unknown }): WorldRunEnvelope | null {
    const now = Date.now();
    const resultJson = input.result !== undefined ? JSON.stringify(input.result) : null;
    const result = this.db.sqlite
      .prepare("UPDATE world_runs SET status = 'committed', result_json = ?, updated_at = ? WHERE id = ?")
      .run(resultJson, now, input.worldRunId);
    if (result.changes === 0) {
      return null;
    }
    return this.getById(input.worldRunId);
  }

  markRejected(input: { worldRunId: string }): WorldRunEnvelope | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare("UPDATE world_runs SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(now, input.worldRunId);
    if (result.changes === 0) {
      return null;
    }
    return this.getById(input.worldRunId);
  }

  markFailed(input: { worldRunId: string }): WorldRunEnvelope | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare("UPDATE world_runs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(now, input.worldRunId);
    if (result.changes === 0) {
      return null;
    }
    return this.getById(input.worldRunId);
  }

  getById(id: string): WorldRunEnvelope | null {
    const row = this.db.sqlite.prepare("SELECT * FROM world_runs WHERE id = ?").get(id) as WorldRunRow | undefined;
    return row ? mapWorldRun(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): WorldRunEnvelope | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM world_runs WHERE idempotency_key = ?")
      .get(idempotencyKey) as WorldRunRow | undefined;
    return row ? mapWorldRun(row) : null;
  }
}

function mapWorldRun(row: WorldRunRow): WorldRunEnvelope {
  return {
    worldRunId: row.id,
    decisionId: row.decision_id,
    sourceType: row.source_type as WorldRunSourceType,
    sourceActionId: row.source_action_id,
    idempotencyKey: row.idempotency_key,
    userId: row.user_id,
    worldId: row.world_id,
    agentId: row.agent_id ?? undefined,
    status: row.status as WorldRunStatus,
    resultJson: row.result_json,
    startedAt: row.created_at,
  };
}
