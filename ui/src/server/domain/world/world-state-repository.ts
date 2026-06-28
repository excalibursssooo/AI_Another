import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { WorldRuntimeState, WorldStateSnapshotRecord } from "./types";

interface WorldStateSnapshotRow {
  id: string;
  user_id: string;
  world_id: string;
  tick: number;
  snapshot_kind: "latest" | "checkpoint" | "rebuild";
  is_latest: number;
  applied_event_sequence: number;
  applied_event_ids_json: string;
  reducer_version: number;
  state_json: string;
  checksum: string | null;
  created_at: number;
  updated_at: number;
}

export function createInitialWorldState(now = Date.now()): WorldRuntimeState {
  return {
    clock: { day: 1, phase: "day", updatedAt: now },
    stability: 0.5,
    tension: 0,
    activeArcIds: [],
    publicFacts: [],
    hiddenFacts: [],
    unresolvedEventIds: [],
  };
}

export function createInitialWorldSnapshot(input: {
  userId: string;
  worldId: string;
  now?: number;
}): WorldStateSnapshotRecord {
  const now = input.now ?? Date.now();
  const state = createInitialWorldState(now);
  return {
    id: `wsnap-${randomUUID()}`,
    userId: input.userId,
    worldId: input.worldId,
    tick: 0,
    snapshotKind: "latest",
    isLatest: true,
    appliedEventSequence: 0,
    appliedEventIds: [],
    reducerVersion: 1,
    state,
    checksum: checksumState(state),
    createdAt: now,
    updatedAt: now,
  };
}

export class WorldStateRepository {
  constructor(private readonly db: AppDatabase) {}

  getLatest(input: { userId: string; worldId: string }): WorldStateSnapshotRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM world_state_snapshots WHERE user_id = ? AND world_id = ? AND is_latest = 1")
      .get(input.userId, input.worldId) as WorldStateSnapshotRow | undefined;
    return row ? mapSnapshot(row) : null;
  }

  saveLatest(input: WorldStateSnapshotRecord): WorldStateSnapshotRecord {
    const result = this.db.sqlite.transaction(() => {
      const now = Date.now();
      const id = `wsnap-${randomUUID()}`;
      const stateJson = JSON.stringify(input.state);
      const checksum = checksumState(input.state);
      this.db.sqlite
        .prepare("UPDATE world_state_snapshots SET is_latest = 0, updated_at = ? WHERE user_id = ? AND world_id = ? AND is_latest = 1")
        .run(now, input.userId, input.worldId);
      this.db.sqlite
        .prepare(
          `INSERT INTO world_state_snapshots
            (id, user_id, world_id, tick, snapshot_kind, is_latest, applied_event_sequence, applied_event_ids_json,
             reducer_version, state_json, checksum, created_at, updated_at)
           VALUES
            (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.worldId,
          input.tick,
          input.snapshotKind,
          input.appliedEventSequence,
          JSON.stringify(input.appliedEventIds),
          input.reducerVersion,
          stateJson,
          checksum,
          input.createdAt,
          now,
        );
      return this.getLatest({ userId: input.userId, worldId: input.worldId }) as WorldStateSnapshotRecord;
    })();
    return result;
  }
}

function checksumState(state: WorldRuntimeState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapSnapshot(row: WorldStateSnapshotRow): WorldStateSnapshotRecord {
  const state = parseJson<WorldRuntimeState>(row.state_json, createInitialWorldState(row.updated_at));
  return {
    id: row.id,
    userId: row.user_id,
    worldId: row.world_id,
    tick: row.tick,
    snapshotKind: row.snapshot_kind,
    isLatest: row.is_latest === 1,
    appliedEventSequence: row.applied_event_sequence,
    appliedEventIds: parseJson(row.applied_event_ids_json, []),
    reducerVersion: row.reducer_version,
    state,
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
