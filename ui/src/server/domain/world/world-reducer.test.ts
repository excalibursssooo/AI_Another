import { describe, expect, it } from "vitest";

import { CharacterStateRecord, PUBLIC_VISIBILITY, WorldEventRecord } from "./types";
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

function makeCharacterState(partial: Partial<CharacterStateRecord> & Pick<CharacterStateRecord, "agentId">): CharacterStateRecord {
  return {
    userId: "u001",
    worldId: "default",
    locationKey: "tavern",
    currentGoal: "",
    emotionalState: { label: "neutral", intensity: 0.5 },
    relationshipToUser: { affinity: 0.5, trust: 0.5, tension: 0 },
    knowledgeKeys: [],
    activeCommandId: null,
    lastActedAt: null,
    updatedAt: 1000,
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
          visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
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
        visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
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

  describe("character state reduction", () => {
    it("knowledge_reveal adds factKey to matching character's knowledgeKeys", () => {
      const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
      const result = reduceWorldEvents({
        previousSnapshot,
        reducerVersion: 1,
        events: [
          event({
            id: "event-kr",
            sequence: 1,
            type: "knowledge_reveal",
            actorIds: ["agent-a"],
            payload: { factKey: "the-sky-is-purple" },
            summary: "revealed sky color",
          }),
        ],
        previousCharacterStates: [
          makeCharacterState({ agentId: "agent-a", knowledgeKeys: [] }),
        ],
      });

      expect(result.characterStates).toBeDefined();
      expect(result.characterStates![0].knowledgeKeys).toContain("the-sky-is-purple");
    });

    it("knowledge_reveal is idempotent — does not duplicate an already-known factKey", () => {
      const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
      const result = reduceWorldEvents({
        previousSnapshot,
        reducerVersion: 1,
        events: [
          event({
            id: "event-kr",
            sequence: 1,
            type: "knowledge_reveal",
            actorIds: ["agent-a"],
            payload: { factKey: "the-sky-is-purple" },
            summary: "revealed sky color",
          }),
        ],
        previousCharacterStates: [
          makeCharacterState({ agentId: "agent-a", knowledgeKeys: ["the-sky-is-purple"] }),
        ],
      });

      expect(result.characterStates![0].knowledgeKeys.filter((k) => k === "the-sky-is-purple")).toHaveLength(1);
    });

    it("character_action move_location updates locationKey and lastActedAt", () => {
      const before = Date.now();
      const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
      const result = reduceWorldEvents({
        previousSnapshot,
        reducerVersion: 1,
        events: [
          event({
            id: "event-move",
            sequence: 1,
            type: "character_action",
            actorIds: ["agent-b"],
            payload: { action: "move_location", locationKey: "market" },
            summary: "moved to market",
          }),
        ],
        previousCharacterStates: [
          makeCharacterState({ agentId: "agent-b", locationKey: "tavern" }),
        ],
      });
      const after = Date.now();

      expect(result.characterStates).toBeDefined();
      expect(result.characterStates![0].locationKey).toBe("market");
      expect(result.characterStates![0].lastActedAt).toBeGreaterThanOrEqual(before);
      expect(result.characterStates![0].lastActedAt).toBeLessThanOrEqual(after);
    });

    it("user_action observed_only advances appliedEventIds and sequence without mutating character state", () => {
      const previousSnapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "default", now: 1000 });
      const charState = makeCharacterState({ agentId: "agent-c", locationKey: "tavern", knowledgeKeys: ["fact-x"] });
      const result = reduceWorldEvents({
        previousSnapshot,
        reducerVersion: 1,
        events: [
          event({
            id: "event-obs",
            sequence: 1,
            type: "user_action",
            actorIds: [],
            payload: {
              clientActionId: "client-1",
              normalizedMessage: "look around",
              targetAgentId: "agent-c",
              interpretationStatus: "observed_only",
            },
            summary: "observed only",
          }),
        ],
        previousCharacterStates: [charState],
      });

      expect(result.appliedEventIds).toContain("event-obs");
      expect(result.worldSnapshot.appliedEventSequence).toBe(1);
      expect(result.characterStates).toBeDefined();
      expect(result.characterStates![0].locationKey).toBe("tavern");
      expect(result.characterStates![0].knowledgeKeys).toEqual(["fact-x"]);
    });
  });
});
