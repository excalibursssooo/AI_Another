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
  created_at: number;
  updated_at: number;
}

export class TaskRepository {
  constructor(private readonly db: AppDatabase) {}

  enqueue(input: { kind: string; payload: unknown; runAfter?: number }): TaskRecord {
    const now = Date.now();
    const id = `task-${randomUUID()}`;
    const runAfter = input.runAfter ?? now;
    this.db.sqlite
      .prepare(
        `INSERT INTO tasks
          (id, kind, payload_json, status, attempts, last_error, run_after, created_at, updated_at)
         VALUES
          (?, ?, ?, 'pending', 0, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        runAfter,
        now,
        now,
      );
    return this.get(id) as TaskRecord;
  }

  claimNext(opts?: { kinds?: string[] }): TaskRecord | null {
    const now = Date.now();
    const kinds = opts?.kinds && opts.kinds.length > 0 ? opts.kinds : null;

    const selectSql = kinds
      ? `SELECT * FROM tasks
         WHERE status = 'pending'
           AND run_after <= ?
           AND kind IN (${kinds.map(() => "?").join(", ")})
         ORDER BY run_after ASC, created_at ASC
         LIMIT 1`
      : `SELECT * FROM tasks
         WHERE status = 'pending'
           AND run_after <= ?
         ORDER BY run_after ASC, created_at ASC
         LIMIT 1`;
    const selectParams = kinds ? [now, ...kinds] : [now];

    const row = this.db.sqlite.prepare(selectSql).get(...selectParams) as TaskRow | undefined;
    if (!row) {
      return null;
    }

    this.db.sqlite
      .prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
      .run(now, row.id);

    return this.get(row.id);
  }

  markDone(id: string): TaskRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
      .run(now, id);
    if (result.changes === 0) {
      return null;
    }
    return this.get(id);
  }

  markFailed(id: string, error: string): TaskRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE tasks
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(error, now, id);
    if (result.changes === 0) {
      return null;
    }
    return this.get(id);
  }

  get(id: string): TaskRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
