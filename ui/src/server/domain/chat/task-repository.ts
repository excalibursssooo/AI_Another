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

export class TaskRepository {
  constructor(private readonly db: AppDatabase) {}

  enqueue(input: { kind: string; payload: unknown; runAfter?: number }): TaskRecord {
    void input;
    throw new Error("TaskRepository.enqueue: not implemented yet — will land in W5.1");
  }

  claimNext(opts?: { kinds?: string[] }): TaskRecord | null {
    void opts;
    throw new Error("TaskRepository.claimNext: not implemented yet — will land in W5.1");
  }

  markDone(id: string): TaskRecord | null {
    void id;
    throw new Error("TaskRepository.markDone: not implemented yet — will land in W5.1");
  }

  markFailed(id: string, error: string): TaskRecord | null {
    void id;
    void error;
    throw new Error("TaskRepository.markFailed: not implemented yet — will land in W5.1");
  }

  get(id: string): TaskRecord | null {
    void id;
    throw new Error("TaskRepository.get: not implemented yet — will land in W5.1");
  }
}
