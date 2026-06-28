import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { PUBLIC_VISIBILITY } from "./types";
import { WorldEventRepository } from "./world-event-repository";

describe("WorldEventRepository", () => {
  it("allocates monotonically increasing sequence per user and world", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    expect(events.allocateNextSequence({ userId: "u001", worldId: "default" })).toBe(1);
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "user said hello",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });

    expect(events.allocateNextSequence({ userId: "u001", worldId: "default" })).toBe(2);
    expect(events.allocateNextSequence({ userId: "u002", worldId: "default" })).toBe(1);
  });

  it("returns existing event for duplicate idempotency key", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    const first = events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 1,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "user said hello",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });
    const second = events.createCommitted({
      decisionId: "decision-2",
      worldRunId: "run-2",
      userId: "u001",
      worldId: "default",
      tick: 0,
      sequence: 2,
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "hello again",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "duplicate",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "world:u001:default:client-1",
    });

    expect(second.id).toBe(first.id);
    expect(second.sequence).toBe(1);
    expect(second.summary).toBe("user said hello");
  });

  it("lists committed events by sequence rather than created_at", () => {
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
      payload: { title: "second", description: "second event" },
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
      type: "user_action",
      payload: {
        clientActionId: "client-1",
        normalizedMessage: "first",
        targetAgentId: "agent-default",
        interpretationStatus: "accepted",
      },
      summary: "first",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["agent-default"],
      idempotencyKey: "event-1",
    });

    expect(events.listCommitted({ userId: "u001", worldId: "default" }).map((event) => event.sequence)).toEqual([1, 2]);
  });
});
