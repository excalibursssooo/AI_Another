import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";
import type { WorldMindDecision } from "@/server/domain/world/world-decision";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository } from "@/server/domain/world/character-state-repository";
import { WorldDecisionLogRepository } from "@/server/domain/world/world-decision-log-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { WorldStateRepository } from "@/server/domain/world/world-state-repository";
import { createWorldMindFlow } from "./world-mind-flow";

function makeValidWorldMindDecision(overrides: Partial<WorldMindDecision> = {}): WorldMindDecision {
  return {
    observations: [],
    proposedEvents: [
      {
        clientEventId: "evt-derived-1",
        type: "world_incident",
        actorIds: ["agent-default"],
        payload: {
          title: "an incident",
          description: "something happened",
          tensionDelta: 0.1,
          stabilityDelta: -0.05,
        },
        visibility: { mode: "public", visibleToActorIds: [] },
        summary: "an incident",
      },
    ],
    proposedCommands: [
      {
        commandType: "speak_to_user",
        targetAgentId: "agent-default",
        priority: "normal",
        visibility: { mode: "public", visibleToActorIds: [] },
        visibleToUser: false,
        actorInstruction: "say hello",
        privateReason: null,
        cause: { type: "proposed_event", clientEventId: "evt-derived-1" },
        payload: {},
        relatedEventSummary: null,
      },
    ],
    memoryCandidates: [],
    nextTick: { delayMs: 60_000, reason: "test" },
    ...overrides,
  };
}

describe("WorldMindFlow", () => {
  // -------------------------------------------------------------------------
  // accepted decision
  // -------------------------------------------------------------------------
  it("accepted decision commits one user_action and one derived event with shared decision and run ids, snapshot sequence 2, one pending command, and accepted decision log", async () => {
    const db = createTestDatabase();

    // Set up world + agent (already seeded: worldId="default", agentId="agent-default")
    const worldRepo = new WorldRepository(db);
    worldRepo.upsert({ id: "default", name: "Test World", lore: "", tone: "", constraints: [], seedMemories: [] });

    // Create character state for the agent so it is "active"
    const charRepo = new CharacterStateRepository(db);
    charRepo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });

    // Create run envelope
    const runRepo = new WorldRunRepository(db);
    const envelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: `test-run:${Math.random()}`,
    });

    const decision = makeValidWorldMindDecision();

    const result = await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "user said hi", targetAgentId: "agent-default" },
      generateDecision: async () => decision,
    });

    // --- assertions ---
    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });

    expect(events).toHaveLength(2);

    const [userAction, derivedEvent] = events;
    expect(userAction.type).toBe("user_action");
    expect(userAction.decisionId).toBe(envelope.decisionId);
    expect(userAction.worldRunId).toBe(envelope.worldRunId);

    expect(derivedEvent.type).toBe("world_incident");
    expect(derivedEvent.decisionId).toBe(envelope.decisionId);
    expect(derivedEvent.worldRunId).toBe(envelope.worldRunId);

    // Snapshot sequence = 2
    const snapshotRepo = new WorldStateRepository(db);
    const snapshot = snapshotRepo.getLatest({ userId: "u001", worldId: "default" });
    expect(snapshot?.appliedEventSequence).toBe(2);

    // One pending command
    const cmdRepo = new ActorCommandRepository(db);
    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ? AND status = 'pending'")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(1);
    expect(commands[0].command_type).toBe("speak_to_user");
    expect(commands[0].actor_instruction).toBe("say hello");

    // Decision log
    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("accepted");
    expect(logs[0].createdEventIdsJson).toContain(userAction.id);
    expect(logs[0].createdCommandIdsJson).toHaveLength(1);

    // Run status
    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("committed");
  });

  // -------------------------------------------------------------------------
  // rejected decision — validation failure
  // -------------------------------------------------------------------------
  it("rejected decision commits only observed_only user_action, no commands, and rejected decision log", async () => {
    const db = createTestDatabase();

    const worldRepo = new WorldRepository(db);
    worldRepo.upsert({ id: "default", name: "Test World", lore: "", tone: "", constraints: [], seedMemories: [] });

    const charRepo = new CharacterStateRepository(db);
    charRepo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });

    const runRepo = new WorldRunRepository(db);
    const envelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: `test-run:${Math.random()}`,
    });

    // Decision with a command referencing a non-existent clientEventId → validator rejects
    const decision = makeValidWorldMindDecision({
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: false,
          actorInstruction: "should not appear",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-nonexistent" }, // ← invalid
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "hello", targetAgentId: "agent-default" },
      generateDecision: async () => decision,
    });

    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });

    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.type).toBe("user_action");
    expect((evt.payload as { interpretationStatus: string }).interpretationStatus).toBe("observed_only");

    const cmdRepo = new ActorCommandRepository(db);
    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ?")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(0);

    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("rejected");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("rejected");
  });

  // -------------------------------------------------------------------------
  // model_failed — director throws
  // -------------------------------------------------------------------------
  it("model_failed commits observed_only user_action, no commands, and model_failed decision log", async () => {
    const db = createTestDatabase();

    const worldRepo = new WorldRepository(db);
    worldRepo.upsert({ id: "default", name: "Test World", lore: "", tone: "", constraints: [], seedMemories: [] });

    const charRepo = new CharacterStateRepository(db);
    charRepo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });

    const runRepo = new WorldRunRepository(db);
    const envelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: `test-run:${Math.random()}`,
    });

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "hello", targetAgentId: "agent-default" },
      generateDecision: async () => {
        throw new Error("model unavailable");
      },
    });

    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });

    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.type).toBe("user_action");
    expect((evt.payload as { interpretationStatus: string }).interpretationStatus).toBe("observed_only");

    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ?")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(0);

    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("model_failed");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // transaction_failed — duplicate command idempotency key inside transaction
  // -------------------------------------------------------------------------
  it("transaction_failed rolls back all writes and creates a best-effort decision log", async () => {
    const db = createTestDatabase();

    const worldRepo = new WorldRepository(db);
    worldRepo.upsert({ id: "default", name: "Test World", lore: "", tone: "", constraints: [], seedMemories: [] });

    const charRepo = new CharacterStateRepository(db);
    charRepo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });

    const runRepo = new WorldRunRepository(db);
    const envelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: `test-run:${Math.random()}`,
    });

    const sharedIdempotencyKey = "cmd-dup-key";

    // Decision with TWO commands sharing the same idempotency_key.
    // Validator does NOT check command idempotency, so it passes.
    // SQLite UNIQUE constraint on actor_commands.idempotency_key causes the
    // transaction to roll back on the second insert.
    const decision = makeValidWorldMindDecision({
      proposedEvents: [
        {
          clientEventId: "evt-derived-1",
          type: "world_incident",
          actorIds: ["agent-default"],
          payload: { title: "an incident", description: "something happened" },
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "an incident",
        },
      ],
      proposedCommands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: false,
          actorInstruction: "first",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-derived-1" },
          payload: {},
          relatedEventSummary: null,
        },
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "high",
          visibility: { mode: "public", visibleToActorIds: [] },
          visibleToUser: false,
          actorInstruction: "second (duplicate key)",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-derived-1" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
      observations: [],
      memoryCandidates: [],
      nextTick: { delayMs: 60_000, reason: "test" },
      // Both commands have the same targetAgentId, commandType, and clientEventId,
      // so they generate the same idempotency_key internally in the flow.
      // forceCommandInsert bypasses the de-duplication check, hitting SQLite's
      // UNIQUE constraint and rolling back the transaction.
    });

    await expect(
      createWorldMindFlow({
        db,
        envelope,
        sourceInput: { message: "hello", targetAgentId: "agent-default" },
        // forceCommandInsert bypasses idempotency de-duplication so the duplicate
        // idempotency key hits SQLite's UNIQUE constraint and rolls back the tx.
        forceCommandInsert: true,
        generateDecision: async () => decision,
      }),
    ).rejects.toThrow();

    // The user_action is also rolled back — no committed events at all
    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });
    expect(events).toHaveLength(0);

    // A best-effort transaction_failed decision log was written outside the tx
    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("transaction_failed");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("failed");
  });
});
