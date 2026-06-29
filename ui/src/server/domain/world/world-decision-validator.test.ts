import { describe, expect, it } from "vitest";
import { validateWorldMindDecision } from "./world-decision-validator";
import { WorldMindDecisionSchema, type WorldMindDecision } from "./world-decision";

function makeDecision(overrides: Partial<WorldMindDecision> = {}): WorldMindDecision {
  return {
    observations: [],
    intent: "dispatch_commands",
    events: [],
    commands: [],
    memories: [],
    nextTick: null,
    ...overrides,
  };
}

describe("validateWorldMindDecision", () => {
  it("parses the spec-aligned decision field names", () => {
    const parsed = WorldMindDecisionSchema.parse({
      observations: ["The user greeted the guard."],
      intent: "dispatch_commands",
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: ["agent-default"],
          payload: {
            title: "A guard notices the user",
            description: "The guard pauses and studies the user.",
            tensionDelta: 0.05,
          },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "The guard notices the user.",
        },
      ],
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "Ask the user what business brings them here.",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-1" },
          payload: {},
          relatedEventSummary: "The guard notices the user.",
        },
      ],
      memories: [],
      nextTick: null,
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.memories).toEqual([]);
  });

  it("allows nextTick to be null in the structured decision schema", () => {
    const parsed = WorldMindDecisionSchema.parse({
      observations: ["The scene is quiet."],
      intent: "dispatch_commands",
      events: [],
      commands: [],
      memories: [],
      nextTick: null,
    });

    expect(parsed.observations).toEqual(["The scene is quiet."]);
    expect(parsed.nextTick).toBeNull();
  });

  it("accepts a valid decision with one proposed event and one command referencing it", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: ["agent-a"],
          payload: { title: "User greeted", description: "The user said hello to the guard." },
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "User said hello",
        },
      ],
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
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

  it("rejects duplicate clientEventId in events", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
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
      commands: [],
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

  it("rejects unknown event types", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "state_patch",
          actorIds: ["agent-a"],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "Illegal patch",
        },
      ],
      commands: [],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a"],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("state_patch"))).toBe(true);
    }
  });

  it("rejects command cause referencing a missing proposed event", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: ["agent-a"],
          payload: {},
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "Only event",
        },
      ],
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
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
      events: [],
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "ghost",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
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
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
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

  it("rejects private actorInstruction containing hidden fact summary", () => {
    const decision = makeDecision({
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "private", visibleToActorIds: [] },
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

  it("rejects proposed event actor ids outside the active actor set", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: ["ghost-agent"],
          payload: { title: "Incident", description: "Unknown actor appears." },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "Unknown actor appears.",
        },
      ],
    });

    const result = validateWorldMindDecision({ decision, activeAgentIds: ["agent-default"], hiddenFactSummaries: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("Event evt-1 references unknown actor: ghost-agent");
    }
  });

  it("rejects invalid world_incident payloads", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: [],
          payload: { title: "Missing description" },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "Invalid incident.",
        },
      ],
    });

    const result = validateWorldMindDecision({ decision, activeAgentIds: [], hiddenFactSummaries: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("world_incident payload"))).toBe(true);
    }
  });

  it("rejects knowledge_reveal events without a factKey", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "knowledge_reveal",
          actorIds: ["agent-default"],
          payload: { summary: "A secret is revealed." },
          visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
          summary: "A secret is revealed.",
        },
      ],
    });

    const result = validateWorldMindDecision({ decision, activeAgentIds: ["agent-default"], hiddenFactSummaries: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("knowledge_reveal payload"))).toBe(true);
    }
  });

  it("rejects public events that include hidden fact summaries", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: [],
          payload: { title: "Leak", description: "The queen ordered the fire." },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "The queen ordered the fire.",
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: [],
      hiddenFactSummaries: ["The queen ordered the fire."],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a user action that creates more than one major event without a chain reaction", () => {
    const decision = makeDecision({
      events: [
        {
          clientEventId: "evt-1",
          type: "world_incident",
          actorIds: [],
          payload: { title: "First", description: "First major event." },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "First major event.",
        },
        {
          clientEventId: "evt-2",
          type: "arc_progress",
          actorIds: [],
          payload: { patchType: "resolve_thread", threadKey: "thread-1", resolution: "Resolved." },
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          summary: "Second major event.",
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: [],
      hiddenFactSummaries: [],
      sourceType: "user_action",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects speak_to_user commands that are hidden", () => {
    const decision = makeDecision({
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
          actorInstruction: "Respond to the user.",
          privateReason: null,
          cause: { type: "director_no_event", reasonCode: "reply" },
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
      expect(result.errors).toContain("speak_to_user command for agent-a must be actor-visible");
    }
  });

  it("rejects private speak_to_user commands that are not visible to the target actor", () => {
    const decision = makeDecision({
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-a",
          priority: "normal",
          visibility: { mode: "private", visibleToActorIds: ["agent-b"], visibleToUser: false },
          actorInstruction: "Respond to the user.",
          privateReason: null,
          cause: { type: "director_no_event", reasonCode: "reply" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = validateWorldMindDecision({
      decision,
      activeAgentIds: ["agent-a", "agent-b"],
      hiddenFactSummaries: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("speak_to_user command for agent-a must be actor-visible");
    }
  });
});
