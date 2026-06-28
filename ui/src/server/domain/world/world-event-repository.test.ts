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

  it("throws on sequence conflicts that are not idempotent retries", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

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

    expect(() =>
      events.createCommitted({
        decisionId: "decision-2",
        worldRunId: "run-2",
        userId: "u001",
        worldId: "default",
        tick: 0,
        sequence: 1,
        type: "world_incident",
        payload: { title: "conflict", description: "same sequence" },
        summary: "conflicting event",
        visibility: PUBLIC_VISIBILITY,
        actorIds: [],
        idempotencyKey: "event-conflict",
      }),
    ).toThrow(/UNIQUE constraint failed/);
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

  it("listRecentForWorld returns committed events ordered ascending by sequence, limited", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    // Insert several committed events in a known scope
    for (let seq = 1; seq <= 5; seq++) {
      events.createCommitted({
        decisionId: `decision-${seq}`,
        worldRunId: "run-1",
        userId: "u001",
        worldId: "myworld",
        tick: 0,
        sequence: seq,
        type: "world_incident",
        payload: { description: `event ${seq}` },
        summary: `event ${seq}`,
        visibility: PUBLIC_VISIBILITY,
        actorIds: [],
        idempotencyKey: `u001-myworld-event-${seq}`,
      });
    }

    // Insert events in a different scope (different worldId)
    events.createCommitted({
      decisionId: "decision-other",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "other-world",
      tick: 0,
      sequence: 1,
      type: "world_incident",
      payload: { description: "other" },
      summary: "other world event",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "u001-other-event-1",
    });

    const recent = events.listRecentForWorld({ userId: "u001", worldId: "myworld", limit: 3 });

    // Should return only committed events from myworld, ordered ascending, limited to 3
    expect(recent.map((e) => e.sequence)).toEqual([3, 4, 5]);
    // Should NOT include the other-world event
    expect(recent.every((e) => e.worldId === "myworld")).toBe(true);
    // All returned events have committed status (SQL filter: status = 'committed')
    expect(recent.every((e) => e.status === "committed")).toBe(true);
  });

  it("listRecentForActor returns events where agentId is in actorIds, ordered ascending, limited", () => {
    const db = createTestDatabase();
    const events = new WorldEventRepository(db);

    // Events with alice as actor
    events.createCommitted({
      decisionId: "decision-1",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "myworld",
      tick: 0,
      sequence: 1,
      type: "character_action",
      payload: {},
      summary: "alice speaks",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["alice"],
      idempotencyKey: "actor-alice-seq-1",
    });
    events.createCommitted({
      decisionId: "decision-2",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "myworld",
      tick: 0,
      sequence: 2,
      type: "character_action",
      payload: {},
      summary: "alice acts again",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["alice"],
      idempotencyKey: "actor-alice-seq-2",
    });

    // Events with bob as actor
    events.createCommitted({
      decisionId: "decision-3",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "myworld",
      tick: 0,
      sequence: 3,
      type: "character_action",
      payload: {},
      summary: "bob acts",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["bob"],
      idempotencyKey: "actor-bob-seq-3",
    });

    // Event with multiple actors including alice
    events.createCommitted({
      decisionId: "decision-4",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "myworld",
      tick: 0,
      sequence: 4,
      type: "character_action",
      payload: {},
      summary: "alice and carol together",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["alice", "carol"],
      idempotencyKey: "actor-multi-seq-4",
    });

    // Event with no actors
    events.createCommitted({
      decisionId: "decision-5",
      worldRunId: "run-1",
      userId: "u001",
      worldId: "myworld",
      tick: 0,
      sequence: 5,
      type: "world_incident",
      payload: {},
      summary: "world incident",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "actor-none-seq-5",
    });

    const aliceRecent = events.listRecentForActor({ userId: "u001", worldId: "myworld", agentId: "alice", limit: 10 });

    // Should return events where alice is in actorIds, ordered ascending
    expect(aliceRecent.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(aliceRecent.every((e) => e.actorIds.includes("alice"))).toBe(true);

    const bobRecent = events.listRecentForActor({ userId: "u001", worldId: "myworld", agentId: "bob", limit: 10 });
    expect(bobRecent.map((e) => e.sequence)).toEqual([3]);

    // Test limit (query is ORDER BY sequence DESC, so most recent first; limit cuts before reverse)
    const limited = events.listRecentForActor({ userId: "u001", worldId: "myworld", agentId: "alice", limit: 2 });
    // Sequences [4,2,1] filtered → DESC gives [4,2,1] → LIMIT 2 gives [4,2] → reverse gives [2,4]
    expect(limited.map((e) => e.sequence)).toEqual([2, 4]);
  });
});
