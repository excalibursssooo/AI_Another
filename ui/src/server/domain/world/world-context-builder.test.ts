import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldEventRepository } from "./world-event-repository";
import { WorldMemoryRepository } from "./world-memory-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { CharacterStateRepository } from "./character-state-repository";
import { createInitialWorldSnapshot, WorldStateRepository } from "./world-state-repository";
import { buildWorldDirectorContext } from "./world-context-builder";
import { PUBLIC_VISIBILITY } from "./types";

describe("buildWorldDirectorContext", () => {
  it("throws when world id does not exist (no fallback to default)", () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);

    // Ensure default world does NOT exist in this fresh db (or explicitly delete it)
    db.sqlite.exec("DELETE FROM worlds WHERE id = 'default'");

    expect(() =>
      buildWorldDirectorContext({
        userId: "u001",
        worldId: "nonexistent-world",
        db,
      }),
    ).toThrow(/nonexistent-world/);
  });

  it("director context includes snapshot state and recent event summaries", () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);
    const snapshots = new WorldStateRepository(db);
    const events = new WorldEventRepository(db);
    const characters = new CharacterStateRepository(db);

    // Create a world
    worldRepo.upsert({
      id: "myworld",
      name: "Test World",
      lore: "A world for testing",
      tone: "serious",
      constraints: ["no violence"],
      seedMemories: [],
    });

    // Save a snapshot with character state
    const snapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "myworld", now: 1000 });
    const saved = snapshots.saveLatest({
      ...snapshot,
      tick: 5,
      appliedEventSequence: 3,
      appliedEventIds: ["e1", "e2", "e3"],
      state: {
        ...snapshot.state,
        clock: { day: 2, phase: "day", updatedAt: 1000 },
        stability: 0.8,
        tension: 0.1,
        publicFacts: [{ factKey: "fact1", summary: "It is daytime", visibility: PUBLIC_VISIBILITY, sourceEventId: "e1" }],
        hiddenFacts: [],
        activeArcIds: ["arc1"],
        unresolvedEventIds: [],
      },
    });

    // Insert character states
    characters.getOrCreateDefault({ userId: "u001", worldId: "myworld", agentId: "alice" });
    characters.getOrCreateDefault({ userId: "u001", worldId: "myworld", agentId: "bob" });

    // Create some committed events
    events.createCommitted({
      decisionId: "d1",
      worldRunId: "r1",
      userId: "u001",
      worldId: "myworld",
      tick: 1,
      sequence: 1,
      type: "world_incident",
      payload: {},
      summary: "The sun rose",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "ctx-e1",
    });
    events.createCommitted({
      decisionId: "d2",
      worldRunId: "r1",
      userId: "u001",
      worldId: "myworld",
      tick: 2,
      sequence: 2,
      type: "character_action",
      payload: {},
      summary: "Alice went to the market",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["alice"],
      idempotencyKey: "ctx-e2",
    });

    const context = buildWorldDirectorContext({
      userId: "u001",
      worldId: "myworld",
      db,
    });

    // System prompt should include world name and description
    expect(context.system).toContain("Test World");
    expect(context.system).toContain("A world for testing");

    // Active agents should be listed
    expect(context.activeAgentIds).toContain("alice");
    expect(context.activeAgentIds).toContain("bob");

    // Prompt should include recent event summaries
    expect(context.prompt).toContain("The sun rose");
    expect(context.prompt).toContain("Alice went to the market");

    // Should include snapshot character summary in prompt
    expect(context.prompt).toContain("alice");
    expect(context.prompt).toContain("bob");

    // Hash should be deterministic
    const hashInput = context.system + "\n\n" + context.prompt;
    const expectedHash = createHash("sha256").update(hashInput).digest("hex");
    expect(context.promptContextHash).toBe(expectedHash);
  });

  it("actor-facing section excludes hidden facts while validator summaries retain them", () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);
    const snapshots = new WorldStateRepository(db);
    const events = new WorldEventRepository(db);
    const memories = new WorldMemoryRepository(db);

    // Create a world
    worldRepo.upsert({
      id: "aclworld",
      name: "ACL World",
      lore: "",
      tone: "",
      constraints: [],
      seedMemories: [],
    });

    // Save a snapshot
    const snapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "aclworld", now: 1000 });
    snapshots.saveLatest({
      ...snapshot,
      tick: 1,
      appliedEventSequence: 1,
      appliedEventIds: [],
      state: {
        ...snapshot.state,
        hiddenFacts: [
          {
            factKey: "hidden-snapshot-fact",
            summary: "The chancellor forged the treaty.",
            visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
            sourceEventId: "evt-hidden-snapshot",
          },
        ],
      },
    });

    // Create a hidden memory only visible to alice
    memories.create({
      userId: "u001",
      worldId: "aclworld",
      subjectType: "world",
      subjectKey: "secret",
      memoryType: "lore",
      content: "This is a secret visible only to alice",
      visibility: "hidden",
      visibleToActorIds: ["alice"],
      visibleToUser: false,
      importance: 0.9,
      confidence: 1.0,
      validFromTick: 0,
      sourceEventId: null,
      sourceDecisionId: null,
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    events.createCommitted({
      decisionId: "d-hidden",
      worldRunId: "r-hidden",
      userId: "u001",
      worldId: "aclworld",
      tick: 1,
      sequence: 1,
      type: "world_incident",
      payload: {},
      summary: "Hidden event: the queen ordered the fire.",
      visibility: { mode: "hidden", visibleToActorIds: ["alice"], visibleToUser: false },
      actorIds: ["alice"],
      idempotencyKey: "ctx-hidden-event",
    });

    // Create a public memory
    memories.create({
      userId: "u001",
      worldId: "aclworld",
      subjectType: "world",
      subjectKey: "public",
      memoryType: "lore",
      content: "This is public knowledge",
      visibility: "public",
      visibleToActorIds: [],
      visibleToUser: true,
      importance: 0.5,
      confidence: 1.0,
      validFromTick: 0,
      sourceEventId: null,
      sourceDecisionId: null,
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    // Call with bob as targetAgentId — hidden facts should be excluded
    const bobContext = buildWorldDirectorContext({
      userId: "u001",
      worldId: "aclworld",
      targetAgentId: "bob",
      db,
    });

    expect(bobContext.prompt).toContain("public knowledge");
    expect(bobContext.prompt).not.toContain("secret visible only to alice");
    expect(bobContext.prompt).not.toContain("forged the treaty");
    expect(bobContext.prompt).not.toContain("queen ordered the fire");
    expect(bobContext.hiddenFactSummaries).toContain("This is a secret visible only to alice");
    expect(bobContext.hiddenFactSummaries).toContain("The chancellor forged the treaty.");
    expect(bobContext.hiddenFactSummaries).toContain("Hidden event: the queen ordered the fire.");

    // Call with alice as targetAgentId — hidden facts still stay out of actor-facing prompt
    const aliceContext = buildWorldDirectorContext({
      userId: "u001",
      worldId: "aclworld",
      targetAgentId: "alice",
      db,
    });

    expect(aliceContext.prompt).toContain("public knowledge");
    expect(aliceContext.prompt).not.toContain("secret visible only to alice");
    expect(aliceContext.prompt).not.toContain("queen ordered the fire");
    expect(aliceContext.hiddenFactSummaries).toContain("This is a secret visible only to alice");
    expect(aliceContext.hiddenFactSummaries).toContain("The chancellor forged the treaty.");
    expect(aliceContext.hiddenFactSummaries).toContain("Hidden event: the queen ordered the fire.");
  });
});
