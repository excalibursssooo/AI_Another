import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { createInitialWorldSnapshot, WorldStateRepository } from "./world-state-repository";

describe("WorldStateRepository", () => {
  it("saves and loads the latest snapshot", () => {
    const db = createTestDatabase();
    const snapshots = new WorldStateRepository(db);
    const initial = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });

    const saved = snapshots.saveLatest({
      ...initial,
      appliedEventSequence: 1,
      appliedEventIds: ["event-1"],
    });

    expect(saved.isLatest).toBe(true);
    expect(snapshots.getLatest({ userId: "u001", worldId: "default" })?.appliedEventSequence).toBe(1);
  });

  it("allows multiple snapshots in one tick by applied event sequence", () => {
    const db = createTestDatabase();
    const snapshots = new WorldStateRepository(db);
    const initial = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });

    snapshots.saveLatest({ ...initial, tick: 0, appliedEventSequence: 1, appliedEventIds: ["event-1"] });
    const second = snapshots.saveLatest({ ...initial, tick: 0, appliedEventSequence: 2, appliedEventIds: ["event-1", "event-2"] });

    expect(second.tick).toBe(0);
    expect(second.appliedEventSequence).toBe(2);
    expect(snapshots.getLatest({ userId: "u001", worldId: "default" })?.appliedEventSequence).toBe(2);

    const rows = db.sqlite
      .prepare("SELECT applied_event_sequence, is_latest FROM world_state_snapshots WHERE user_id = ? AND world_id = ? ORDER BY applied_event_sequence")
      .all("u001", "default") as Array<{ applied_event_sequence: number; is_latest: number }>;
    expect(rows).toEqual([
      { applied_event_sequence: 1, is_latest: 0 },
      { applied_event_sequence: 2, is_latest: 1 },
    ]);
  });

  it("recomputes checksum from state instead of trusting caller input", () => {
    const db = createTestDatabase();
    const snapshots = new WorldStateRepository(db);
    const initial = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });

    const saved = snapshots.saveLatest({
      ...initial,
      appliedEventSequence: 1,
      appliedEventIds: ["event-1"],
      state: {
        ...initial.state,
        tension: 0.2,
      },
      checksum: initial.checksum,
    });

    expect(saved.checksum).not.toBe(initial.checksum);
    expect(saved.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
