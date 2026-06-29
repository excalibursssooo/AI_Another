import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";

export interface TaskRecord {
  id: string;
  kind: string;
  payload: unknown;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  runAfter: number;
  idempotencyKey: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
  lockExpiresAt: number | null;
  maxAttempts: number;
  nextAttemptAt: number | null;
  completedAt: number | null;
  failedPermanentlyAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  kind: string;
  payload_json: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  run_after: number;
  idempotency_key: string | null;
  locked_by: string | null;
  locked_at: number | null;
  lock_expires_at: number | null;
  max_attempts: number;
  next_attempt_at: number | null;
  completed_at: number | null;
  failed_permanently_at: number | null;
  created_at: number;
  updated_at: number;
}

export class TaskRepository {
  constructor(private readonly db: AppDatabase) {}

  enqueue(input: {
    kind: string;
    payload: unknown;
    runAfter?: number;
    idempotencyKey?: string | null;
    maxAttempts?: number;
  }): TaskRecord {
    if (input.idempotencyKey) {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const now = Date.now();
    const id = `task-${randomUUID()}`;
    const runAfter = input.runAfter ?? now;
    const nextAttemptAt = runAfter;
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO tasks
            (id, kind, payload_json, status, attempts, last_error, run_after, idempotency_key,
             max_attempts, next_attempt_at, created_at, updated_at)
           VALUES
            (?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          JSON.stringify(input.payload ?? {}),
          runAfter,
          input.idempotencyKey ?? null,
          input.maxAttempts ?? 3,
          nextAttemptAt,
          now,
          now,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const retry = this.getByIdempotencyKey(input.idempotencyKey);
        if (retry) {
          return retry;
        }
      }
      throw error;
    }
    return this.get(id) as TaskRecord;
  }

  claimNext(opts?: { kinds?: string[]; workerId?: string; leaseMs?: number }): TaskRecord | null {
    const now = Date.now();
    const workerId = opts?.workerId ?? `worker-${process.pid}`;
    const leaseMs = opts?.leaseMs ?? 60_000;
    const lockExpiresAt = now + leaseMs;
    const kinds = opts?.kinds && opts.kinds.length > 0 ? opts.kinds : null;

    return this.db.sqlite.transaction(() => {
      const kindClause = kinds ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const params = kinds ? [now, now, now, ...kinds] : [now, now, now];
      const row = this.db.sqlite
        .prepare(
          `SELECT id FROM tasks
           WHERE status IN ('pending', 'running')
             AND run_after <= ?
             AND COALESCE(next_attempt_at, run_after) <= ?
             AND failed_permanently_at IS NULL
             AND (
               status = 'pending'
               OR (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
             )
             ${kindClause}
           ORDER BY COALESCE(next_attempt_at, run_after) ASC, created_at ASC
           LIMIT 1`,
        )
        .get(...params) as { id: string } | undefined;
      if (!row) {
        return null;
      }

      const result = this.db.sqlite
        .prepare(
          `UPDATE tasks
           SET status = 'running',
               locked_by = ?,
               locked_at = ?,
               lock_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND failed_permanently_at IS NULL
             AND (
               status = 'pending'
               OR (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
             )`,
        )
        .run(workerId, now, lockExpiresAt, now, row.id, now);

      return result.changes === 0 ? null : this.get(row.id);
    })();
  }

  markDone(id: string): TaskRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE tasks
         SET status = 'done',
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
    if (result.changes === 0) {
      return null;
    }
    return this.get(id);
  }

  markFailed(id: string, error: string): TaskRecord | null {
    const now = Date.now();
    const current = this.get(id);
    if (!current) {
      return null;
    }

    const nextAttempts = current.attempts + 1;
    const permanent = nextAttempts >= current.maxAttempts;
    const backoffMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, nextAttempts - 1));
    const result = this.db.sqlite
      .prepare(
        `UPDATE tasks
         SET status = ?,
             attempts = ?,
             last_error = ?,
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL,
             next_attempt_at = ?,
             failed_permanently_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        permanent ? "failed" : "pending",
        nextAttempts,
        error,
        permanent ? null : now + backoffMs,
        permanent ? now : null,
        now,
        id,
      );
    if (result.changes === 0) {
      return null;
    }
    return this.get(id);
  }

  get(id: string): TaskRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): TaskRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM tasks WHERE idempotency_key = ?")
      .get(idempotencyKey) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
}

function mapTask(row: TaskRow): TaskRecord {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    runAfter: row.run_after,
    idempotencyKey: row.idempotency_key,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
    failedPermanentlyAt: row.failed_permanently_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
