import { describe, expect, it } from "vitest";

import { PUBLIC_VISIBILITY, WorldEventRecord } from "./types";
import { reduceWorldEvents } from "./world-reducer";
import { createInitialWorldSnapshot } from "./world-state-repository";

function event(partial: Partial<WorldEventRecord> & Pick<WorldEventRecord, "id" | "sequence" | "type" | "payload" | "summary">): WorldEventRecord {
  return {
    decisionId: "decision-1",
    worldRunId: "run-1",
    userId: "u001",
    worldId: "default",
    tick: 0,
    schemaVersion: 1,
    reducerVersion: 1,
    visibility: PUBLIC_VISIBILITY,
    actorIds: [],
    locationKey: null,
    causedByEventId: null,
    causedByUserActionId: null,
    idempotencyKey: partial.id,
    status: "committed",
    createdAt: partial.sequence,
    ...partial,
  };
}

describe("reduceWorldEvents", () => {
  it("records applied events without treating observed_only user_action as narrative incident", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "user_action",
          payload: {
            clientActionId: "client-1",
            normalizedMessage: "help",
            targetAgentId: "agent-default",
            interpretationStatus: "observed_only",
            failureReason: "model_failed",
          },
          summary: "user asked for help",
        }),
      ],
    });

    expect(result.worldSnapshot.appliedEventIds).toEqual(["event-1"]);
    expect(result.worldSnapshot.appliedEventSequence).toBe(1);
    expect(result.worldSnapshot.state.tension).toBe(0);
    expect(result.worldSnapshot.state.unresolvedEventIds).toEqual([]);
  });

  it("applies world_incident tension and unresolved event changes", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          payload: {
            title: "港口起火",
            description: "南港仓库在夜里起火。",
            tensionDelta: 0.25,
            stabilityDelta: -0.1,
            unresolved: true,
          },
          summary: "南港仓库起火",
        }),
      ],
    });

    expect(result.worldSnapshot.state.tension).toBe(0.25);
    expect(result.worldSnapshot.state.stability).toBe(0.4);
    expect(result.worldSnapshot.state.unresolvedEventIds).toEqual(["event-1"]);
  });

  it("keeps hidden incident facts out of public facts", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          visibility: { level: "hidden", visibleToActorIds: [], visibleToUser: false },
          payload: {
            title: "hidden fire",
            description: "A hidden warehouse burns.",
            factKey: "secret-fire",
          },
          summary: "hidden incident",
        }),
      ],
    });

    expect(result.worldSnapshot.state.publicFacts).toEqual([]);
    expect(result.worldSnapshot.state.hiddenFacts).toEqual([
      {
        factKey: "secret-fire",
        summary: "A hidden warehouse burns.",
        visibility: { level: "hidden", visibleToActorIds: [], visibleToUser: false },
        sourceEventId: "event-1",
      },
    ]);
  });

  it("clears stale checksum when reducer changes snapshot state", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          payload: { title: "first", description: "first", tensionDelta: 0.2 },
          summary: "first",
        }),
      ],
    });

    expect(previousSnapshot.checksum).not.toBeNull();
    expect(result.worldSnapshot.checksum).toBeNull();
  });

  it("sorts input events by sequence before reducing", () => {
    const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
    const result = reduceWorldEvents({
      previousSnapshot,
      reducerVersion: 1,
      events: [
        event({
          id: "event-2",
          sequence: 2,
          type: "world_incident",
          payload: { title: "second", description: "second", tensionDelta: 0.1 },
          summary: "second",
        }),
        event({
          id: "event-1",
          sequence: 1,
          type: "world_incident",
          payload: { title: "first", description: "first", tensionDelta: 0.2 },
          summary: "first",
        }),
      ],
    });

    expect(result.appliedEventIds).toEqual(["event-1", "event-2"]);
    expect(result.worldSnapshot.appliedEventSequence).toBe(2);
    expect(result.worldSnapshot.state.tension).toBe(0.3);
  });
});
