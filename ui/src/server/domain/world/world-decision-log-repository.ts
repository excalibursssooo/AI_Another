import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { CreateWorldDecisionLogInput, WorldDecisionLogRecord, WorldDecisionLogValidationStatus } from "./types";

interface WorldDecisionLogRow {
  id: string;
  decision_id: string;
  world_run_id: string;
  user_id: string;
  world_id: string;
  source_type: string;
  source_event_id: string | null;
  source_task_id: string | null;
  model_provider: string;
  model_name: string;
  prompt_context_hash: string;
  raw_decision_json: string | null;
  validated_decision_json: string | null;
  validation_status: WorldDecisionLogValidationStatus;
  validation_errors_json: string;
  error_code: string | null;
  error_message: string | null;
  created_event_ids_json: string;
  created_command_ids_json: string;
  created_at: number;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value: unknown): string {
  if (value == null) {
    return "[]";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function mapWorldDecisionLog(row: WorldDecisionLogRow): WorldDecisionLogRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    worldRunId: row.world_run_id,
    userId: row.user_id,
    worldId: row.world_id,
    sourceType: row.source_type,
    sourceEventId: row.source_event_id,
    sourceTaskId: row.source_task_id,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    promptContextHash: row.prompt_context_hash,
    rawDecisionJson: row.raw_decision_json,
    validatedDecisionJson: row.validated_decision_json,
    validationStatus: row.validation_status,
    validationErrorsJson: parseJson(row.validation_errors_json, []),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdEventIdsJson: parseJson(row.created_event_ids_json, []),
    createdCommandIdsJson: parseJson(row.created_command_ids_json, []),
    createdAt: row.created_at,
  };
}

export class WorldDecisionLogRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: CreateWorldDecisionLogInput): WorldDecisionLogRecord {
    const id = `wdl-${randomUUID()}`;
    const now = Date.now();

    this.db.sqlite
      .prepare(
        `INSERT INTO world_decision_logs
          (id, decision_id, world_run_id, user_id, world_id, source_type, source_event_id, source_task_id,
           model_provider, model_name, prompt_context_hash, raw_decision_json, validated_decision_json,
           validation_status, validation_errors_json, error_code, error_message,
           created_event_ids_json, created_command_ids_json, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.decisionId,
        input.worldRunId,
        input.userId,
        input.worldId,
        input.sourceType,
        input.sourceEventId ?? null,
        input.sourceTaskId ?? null,
        input.modelProvider,
        input.modelName,
        input.promptContextHash,
        input.rawDecisionJson ?? null,
        input.validatedDecisionJson ?? null,
        input.validationStatus,
        safeJsonStringify(input.validationErrorsJson),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        safeJsonStringify(input.createdEventIdsJson),
        safeJsonStringify(input.createdCommandIdsJson),
        now,
      );

    const created = this.getById(id);
    if (!created) {
      throw new Error(`WorldDecisionLog was not readable after insert: ${id}`);
    }
    return created;
  }

  listForRun(worldRunId: string): WorldDecisionLogRecord[] {
    const rows = this.db.sqlite
      .prepare("SELECT * FROM world_decision_logs WHERE world_run_id = ? ORDER BY created_at ASC")
      .all(worldRunId) as WorldDecisionLogRow[];
    return rows.map(mapWorldDecisionLog);
  }

  private getById(id: string): WorldDecisionLogRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM world_decision_logs WHERE id = ?").get(id) as WorldDecisionLogRow | undefined;
    return row ? mapWorldDecisionLog(row) : null;
  }
}
