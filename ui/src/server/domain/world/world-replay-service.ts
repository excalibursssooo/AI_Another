import type { AppDatabase } from "@/server/db/client";
import type { WorldStateSnapshotRecord } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { reduceWorldEvents } from "./world-reducer";
import { createInitialWorldSnapshot } from "./world-state-repository";

export function rebuildWorldSnapshot(input: {
  db: AppDatabase;
  userId: string;
  worldId: string;
  now?: number;
}): WorldStateSnapshotRecord {
  const events = new WorldEventRepository(input.db).listCommitted({
    userId: input.userId,
    worldId: input.worldId,
  });
  const initial = createInitialWorldSnapshot({
    userId: input.userId,
    worldId: input.worldId,
    now: input.now,
  });
  return reduceWorldEvents({
    previousSnapshot: initial,
    events,
    reducerVersion: 1,
  }).worldSnapshot;
}
