import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { PUBLIC_VISIBILITY } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { rebuildWorldSnapshot } from "./world-replay-service";

describe("rebuildWorldSnapshot", () => {
  it("rebuilds snapshot from committed events in sequence order", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 2,
      type: "world_incident",
      payload: { title: "second", description: "second", tensionDelta: 0.1 },
      summary: "second",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "event-2",
    });
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "world_incident",
      payload: { title: "first", description: "first", tensionDelta: 0.2 },
      summary: "first",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "event-1",
    });

    const rebuilt = rebuildWorldSnapshot({ db, userId: "u001", worldId: "default", now: 1000 });

    expect(rebuilt.appliedEventIds.length).toBe(2);
    expect(rebuilt.appliedEventSequence).toBe(2);
    expect(rebuilt.state.tension).toBe(0.3);
    // appliedEventIds contains event.id values (UUIDs from createCommitted), not idempotency keys
    expect(rebuilt.appliedEventIds[0]).toMatch(/^wevt-/);
    expect(rebuilt.appliedEventIds[1]).toMatch(/^wevt-/);
  });
});
