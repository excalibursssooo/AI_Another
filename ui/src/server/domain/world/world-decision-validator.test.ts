import { describe, expect, it } from "vitest";
import { validateWorldMindDecision } from "./world-decision-validator";
import type { WorldMindDecision } from "./world-decision";

function makeDecision(overrides: Partial<WorldMindDecision>): WorldMindDecision {
  return {
    observations: [],
    proposedEvents: [],
    proposedCommands: [],
    memoryCandidates: [],
    nextTick: { delayMs: 60_000, reason: "tick" },
    ...overrides,
  };
}

describe("validateWorldMindDecision", () => {
  it("accepts a valid decision with one proposed event and one command referencing it", () => {
    const decision = makeDecision({
      proposedEvents: [
        {
          clientEventId: "evt-1",
          type: "user_action",
          actorIds: ["agent-a"],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "User said hello",
        },
      ],
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: true,
          actorInstruction: "Greet the user back",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-1" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe(decision);
    }
  });

  it("rejects duplicate clientEventId in proposedEvents", () => {
    const decision = makeDecision({
      proposedEvents: [
        {
          clientEventId: "evt-1",
          type: "user_action",
          actorIds: ["agent-a"],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "First event",
        },
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: [],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "Duplicate event",
        },
      ],
      proposedCommands: [],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: [],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("evt-1"))).toBe(true);
    }
  });

  it("rejects command cause referencing a missing proposed event", () => {
    const decision = makeDecision({
      proposedEvents: [
        {
          clientEventId: "evt-1",
          type: "user_action",
          actorIds: ["agent-a"],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "Only event",
        },
      ],
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: true,
          actorInstruction: "Respond",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-missing" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("evt-missing"))).toBe(true);
    }
  });

  it("rejects command with unknown targetAgentId", () => {
    const decision = makeDecision({
      proposedEvents: [],
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "ghost",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: true,
          actorInstruction: "Say hello",
          privateReason: null,
          cause: { type: "director_no_event", reasonCode: "no-action" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
    }
  });

  it("rejects public actorInstruction containing hidden fact summary", () => {
    const decision = makeDecision({
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: true,
          actorInstruction: "Remember that the secret is top-secret-keyword",
          privateReason: null,
          cause: { type: "director_no_event", reasonCode: "reminder" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: ["top-secret-keyword"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("top-secret-keyword"))).toBe(true);
    }
  });

  it("allows private actorInstruction to contain hidden fact summary", () => {
    const decision = makeDecision({
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "private", visibleToActorIds: [] },
          visibleToUser: true,
          actorInstruction: "Remember that the secret is top-secret-keyword",
          privateReason: null,
          cause: { type: "director_no_event", reasonCode: "reminder" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: ["top-secret-keyword"],
    });

    expect(result.ok).toBe(true);
  });
});
