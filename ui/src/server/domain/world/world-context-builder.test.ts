import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldEventRepository } from "./world-event-repository";
import { WorldMemoryRepository } from "./world-memory-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { CharacterStateRepository } from "./character-state-repository";
import { createInitialWorldSnapshot, WorldStateRepository } from "./world-state-repository";
import { buildWorldDirectorContext } from "./world-context-builder";
import { PUBLIC_VISIBILITY } from "./types";

describe("buildWorldDirectorContext", () => {
  it("throws when world id does not exist (no fallback to default)", () => {
    const db = createTestDatabase();

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
    snapshots.saveLatest({
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
      audience: "actor",
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
      audience: "actor",
      db,
    });

    expect(aliceContext.prompt).toContain("public knowledge");
    expect(aliceContext.prompt).not.toContain("secret visible only to alice");
    expect(aliceContext.prompt).not.toContain("queen ordered the fire");
    expect(aliceContext.hiddenFactSummaries).toContain("This is a secret visible only to alice");
    expect(aliceContext.hiddenFactSummaries).toContain("The chancellor forged the treaty.");
    expect(aliceContext.hiddenFactSummaries).toContain("Hidden event: the queen ordered the fire.");
  });

  it("prompt contains all layered sections in correct order and respects ACL filtering", () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);
    const snapshots = new WorldStateRepository(db);
    const events = new WorldEventRepository(db);
    const memories = new WorldMemoryRepository(db);
    const characters = new CharacterStateRepository(db);

    // Create a world with lore and constraints
    worldRepo.upsert({
      id: "layeredworld",
      name: "Layered World",
      lore: "Ancient lore of the realm.",
      tone: "epic",
      constraints: ["no cowardice", "honor the old ways"],
      seedMemories: [],
    });

    // Save a snapshot with public and hidden facts
    const snapshot = createInitialWorldSnapshot({ userId: "u001", worldId: "layeredworld", now: 1000 });
    snapshots.saveLatest({
      ...snapshot,
      tick: 3,
      appliedEventSequence: 2,
      appliedEventIds: [],
      state: {
        ...snapshot.state,
        clock: { day: 5, phase: "day", updatedAt: 1000 },
        stability: 0.75,
        tension: 0.3,
        publicFacts: [{ factKey: "pub_fact1", summary: "The river runs south.", visibility: PUBLIC_VISIBILITY, sourceEventId: "e1" }],
        hiddenFacts: [
          {
            factKey: "hidden_fact1",
            summary: "hidden director memory",
            visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
            sourceEventId: "e2",
          },
        ],
      },
    });

    // Create character state
    characters.getOrCreateDefault({ userId: "u001", worldId: "layeredworld", agentId: "alice" });

    // Create one public world event
    events.createCommitted({
      decisionId: "d1",
      worldRunId: "r1",
      userId: "u001",
      worldId: "layeredworld",
      tick: 1,
      sequence: 1,
      type: "world_incident",
      payload: {},
      summary: "A public world event occurred.",
      visibility: PUBLIC_VISIBILITY,
      actorIds: [],
      idempotencyKey: "ctx-layered-we1",
    });

    // Create one actor-specific event
    events.createCommitted({
      decisionId: "d2",
      worldRunId: "r1",
      userId: "u001",
      worldId: "layeredworld",
      tick: 2,
      sequence: 2,
      type: "character_action",
      payload: {},
      summary: "Alice performed an action.",
      visibility: PUBLIC_VISIBILITY,
      actorIds: ["alice"],
      idempotencyKey: "ctx-layered-ce1",
    });

    // Create one hidden event
    events.createCommitted({
      decisionId: "d3",
      worldRunId: "r1",
      userId: "u001",
      worldId: "layeredworld",
      tick: 3,
      sequence: 3,
      type: "world_incident",
      payload: {},
      summary: "A secret event unfolded.",
      visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
      actorIds: [],
      idempotencyKey: "ctx-layered-he1",
    });

    // Create one public world memory
    memories.create({
      userId: "u001",
      worldId: "layeredworld",
      subjectType: "world",
      subjectKey: "public_mem",
      memoryType: "lore",
      content: "public world memory",
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

    // Create one hidden world memory
    memories.create({
      userId: "u001",
      worldId: "layeredworld",
      subjectType: "world",
      subjectKey: "hidden_mem",
      memoryType: "lore",
      content: "hidden director memory",
      visibility: "hidden",
      visibleToActorIds: [],
      visibleToUser: false,
      importance: 0.8,
      confidence: 1.0,
      validFromTick: 0,
      sourceEventId: null,
      sourceDecisionId: null,
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    const context = buildWorldDirectorContext({
      userId: "u001",
      worldId: "layeredworld",
      sourceInput: { message: "What happens next?", targetAgentId: "alice" },
      db,
    });

    // System prompt must contain Output Contract
    expect(context.system).toContain("Output Contract");

    // All required prompt sections must be present
    expect(context.prompt).toContain("## Immutable Canon");
    expect(context.prompt).toContain("## Runtime Snapshot");
    expect(context.prompt).toContain("## Actor Slice");
    expect(context.prompt).toContain("## Recent World Events");
    expect(context.prompt).toContain("## Recent Actor Events");
    expect(context.prompt).toContain("## Current Source");
    expect(context.prompt).toContain("## Retrieved World Memory");
    expect(context.prompt).toContain("## Output Contract");

    // Public content appears in prompt
    expect(context.prompt).toContain("public world memory");

    // Default director context includes hidden director facts. Actor prompt
    // filtering is a separate audience mode.
    expect(context.prompt).toContain("hidden director memory");
    expect(context.prompt).toContain("A secret event unfolded.");

    // But hidden content IS in hiddenFactSummaries for validator
    expect(context.hiddenFactSummaries).toContain("hidden director memory");
  });

  it("actor audience filters hidden director context even when a target actor is selected", () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);
    const events = new WorldEventRepository(db);
    const memories = new WorldMemoryRepository(db);

    worldRepo.upsert({
      id: "actorfilterworld",
      name: "Actor Filter World",
      lore: "",
      tone: "",
      constraints: [],
      seedMemories: [],
    });

    memories.create({
      userId: "u001",
      worldId: "actorfilterworld",
      subjectType: "world",
      subjectKey: "hidden_mem",
      memoryType: "lore",
      content: "director-only hidden memory",
      visibility: "hidden",
      visibleToActorIds: ["alice"],
      visibleToUser: false,
      importance: 0.8,
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
      worldId: "actorfilterworld",
      tick: 1,
      sequence: 1,
      type: "world_incident",
      payload: {},
      summary: "director-only hidden event",
      visibility: { mode: "hidden", visibleToActorIds: ["alice"], visibleToUser: false },
      actorIds: ["alice"],
      idempotencyKey: "actor-filter-hidden-event",
    });

    const context = buildWorldDirectorContext({
      userId: "u001",
      worldId: "actorfilterworld",
      targetAgentId: "alice",
      audience: "actor",
      db,
    });

    expect(context.prompt).not.toContain("director-only hidden memory");
    expect(context.prompt).not.toContain("director-only hidden event");
    expect(context.hiddenFactSummaries).toContain("director-only hidden memory");
    expect(context.hiddenFactSummaries).toContain("director-only hidden event");
  });
});
