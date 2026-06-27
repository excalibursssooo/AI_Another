import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@/server/db/client";

export type MemoryOpKind =
  | "throttled"
  | "embedding_fallback"
  | "conflict"
  | "no_conflict"
  | "topic_fallback";

export interface MemoryOperationLogRecord {
  id: string;
  userId: string;
  agentId: string;
  worldId: string;
  kind: MemoryOpKind;
  reason: string;
  detail: Record<string, unknown> | null;
  sourceTaskId: string | null;
  createdAt: number;
}

export interface RecordInput {
  userId: string;
  agentId: string;
  worldId: string;
  kind: MemoryOpKind;
  reason: string;
  detail?: Record<string, unknown>;
  sourceTaskId?: string | null;
}

export interface ListRecentInput {
  kind?: MemoryOpKind;
  limit?: number;
}

export class MemoryOperationLogRepository {
  constructor(private readonly db: AppDatabase) {}

  record(input: RecordInput): void {
    const now = Date.now();
    const id = `mem-op-${randomUUID()}`;
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO memory_operation_logs
            (id, user_id, agent_id, world_id, kind, reason, detail, source_task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.agentId,
          input.worldId,
          input.kind,
          input.reason,
          input.detail ? JSON.stringify(input.detail) : null,
          input.sourceTaskId ?? null,
          now,
        );
    } catch (error) {
      console.error("[memory-ops] failed to record log:", error);
      return;
    }

    const verboseOnly = input.kind === "no_conflict" || input.kind === "topic_fallback";
    const verboseEnabled = process.env.MEMORY_OP_VERBOSE_LOG === "true";
    if (!verboseOnly || verboseEnabled) {
      const level: "info" | "warn" = input.kind === "embedding_fallback" ? "warn" : "info";
      console[level]("[memory-ops]", JSON.stringify({
        kind: input.kind,
        reason: input.reason,
        scope: `${input.userId}/${input.agentId}/${input.worldId}`,
        sourceTaskId: input.sourceTaskId ?? null,
        ts: now,
      }));
    }
  }

  listRecent(input: ListRecentInput): MemoryOperationLogRecord[] {
    const limit = Math.max(0, Math.min(1000, input.limit ?? 50));
    const sql = input.kind
      ? `SELECT * FROM memory_operation_logs WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
      : `SELECT * FROM memory_operation_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    const params = input.kind ? [input.kind, limit] : [limit];
    const rows = this.db.sqlite.prepare(sql).all(...params) as Array<{
      id: string; user_id: string; agent_id: string; world_id: string;
      kind: MemoryOpKind; reason: string; detail: string | null;
      source_task_id: string | null; created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      agentId: r.agent_id,
      worldId: r.world_id,
      kind: r.kind,
      reason: r.reason,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      sourceTaskId: r.source_task_id,
      createdAt: r.created_at,
    }));
  }
}
