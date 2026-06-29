import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

// Mutable flag controlled by the transaction_failed test.
// vi.hoisted ensures this is evaluated before the hoisted vi.mock factory runs.
const shouldThrow = vi.hoisted(() => ({ value: false }));

vi.mock("@/server/domain/world/actor-command-repository", async () => {
  const { ActorCommandRepository: RealRepo } = await vi.importActual(
    "@/server/domain/world/actor-command-repository",
  );
  return {
    ActorCommandRepository: function (db: ConstructorParameters<typeof RealRepo>[0]) {
      const realInstance = new RealRepo(db);
      return {
        ...realInstance,
        createMany: (...args: Parameters<typeof realInstance.createMany>) => {
          if (shouldThrow.value) {
            throw new Error("UNIQUE constraint failed: actor_commands.idempotency_key");
          }
          return realInstance.createMany(...args);
        },
      } as typeof realInstance;
    },
  };
});

function makeValidWorldMindDecision(overrides: Partial<WorldMindDecision> = {}): WorldMindDecision {
  return {
    observations: [],
    intent: "dispatch_commands",
    events: [
      {
        clientEventId: "evt-derived-1",
        type: "world_incident",
        actorIds: ["agent-default"],
        payload: {
          title: "an incident",
          description: "something happened",
          factKey: "incident-fact",
          tensionDelta: 0.1,
          stabilityDelta: -0.05,
        },
        visibility: { mode: "public", visibleToActorIds: [] },
        summary: "an incident",
      },
    ],
    commands: [
      {
        commandType: "speak_to_user",
        targetAgentId: "agent-default",
        priority: "normal",
        visibility: { mode: "public", visibleToActorIds: [] },
        actorInstruction: "say hello",
        privateReason: null,
        cause: { type: "proposed_event", clientEventId: "evt-derived-1" },
        payload: {},
        relatedEventSummary: null,
      },
    ],
    memories: [],
    nextTick: { delayMs: 60_000, reason: "test" },
    ...overrides,
  };
}

describe("WorldMindFlow", () => {
  afterEach(() => {
    shouldThrow.value = false;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // accepted decision
  // -------------------------------------------------------------------------
  it("accepted decision commits one user_action and one derived event with shared decision and run ids, snapshot sequence 2, one pending command, and accepted decision log", async () => {
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

    const decision = makeValidWorldMindDecision();

    const result = await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "user said hi", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });

    expect(events).toHaveLength(2);

    const [userAction, derivedEvent] = events;
    expect(userAction.type).toBe("user_action");
    expect(userAction.decisionId).toBe(envelope.decisionId);
    expect(userAction.worldRunId).toBe(envelope.worldRunId);
    expect((userAction.payload as { interpretationStatus: string }).interpretationStatus).toBe("accepted");

    expect(derivedEvent.type).toBe("world_incident");
    expect(derivedEvent.decisionId).toBe(envelope.decisionId);
    expect(derivedEvent.worldRunId).toBe(envelope.worldRunId);
    expect(derivedEvent.idempotencyKey).toBe(`${envelope.worldRunId}:evt-derived-1`);
    expect(derivedEvent.visibility.visibleToUser).toBe(true);

    const snapshotRepo = new WorldStateRepository(db);
    const snapshot = snapshotRepo.getLatest({ userId: "u001", worldId: "default" });
    expect(snapshot?.appliedEventSequence).toBe(2);
    expect(snapshot?.state.publicFacts.map((fact) => fact.factKey)).toContain("incident-fact");

    const cmdRepo = new ActorCommandRepository(db);
    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ? AND status = 'pending'")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(1);
    expect(commands[0].command_type).toBe("speak_to_user");
    expect(commands[0].actor_instruction).toBe("say hello");

    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("accepted");
    expect(logs[0].createdEventIdsJson).toContain(userAction.id);
    expect(logs[0].createdCommandIdsJson).toHaveLength(1);
    expect(logs[0].rawDecisionJson).toContain('"intent"');
    expect(logs[0].validatedDecisionJson).toContain('"events"');
    expect(logs[0].promptContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0].modelProvider).toBe("test");
    expect(logs[0].modelName).toBe("test-director");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("committed");
  });

  it("scopes proposed event and command idempotency keys by worldRunId", async () => {
    const db = createTestDatabase();
    const worldRepo = new WorldRepository(db);
    worldRepo.upsert({ id: "default", name: "Test World", lore: "", tone: "", constraints: [], seedMemories: [] });

    const charRepo = new CharacterStateRepository(db);
    charRepo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });

    const runRepo = new WorldRunRepository(db);
    const firstEnvelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "test-run:client-1",
    });
    const secondEnvelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-2",
      idempotencyKey: "test-run:client-2",
    });

    await createWorldMindFlow({
      db,
      envelope: firstEnvelope,
      sourceInput: { message: "first", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision: makeValidWorldMindDecision(),
        rawDecisionJson: JSON.stringify(makeValidWorldMindDecision()),
        modelProvider: "test",
        modelName: "test-director",
      }),
    });
    await createWorldMindFlow({
      db,
      envelope: secondEnvelope,
      sourceInput: { message: "second", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision: makeValidWorldMindDecision(),
        rawDecisionJson: JSON.stringify(makeValidWorldMindDecision()),
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });
    expect(events).toHaveLength(4);
    expect(events.filter((event) => event.type === "world_incident").map((event) => event.worldRunId)).toEqual([
      firstEnvelope.worldRunId,
      secondEnvelope.worldRunId,
    ]);

    const commandRows = db.sqlite
      .prepare("SELECT world_run_id, idempotency_key FROM actor_commands ORDER BY created_at ASC")
      .all() as Array<{ world_run_id: string; idempotency_key: string }>;
    expect(commandRows).toHaveLength(2);
    expect(commandRows.map((row) => row.world_run_id)).toEqual([firstEnvelope.worldRunId, secondEnvelope.worldRunId]);
    expect(commandRows[0].idempotency_key).not.toBe(commandRows[1].idempotency_key);
  });

  it("prepares default character state for active world agents before validation", async () => {
    const db = createTestDatabase();
    const runRepo = new WorldRunRepository(db);
    const envelope = runRepo.createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "test-run:no-character-state",
    });

    const result = await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "hello", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision: makeValidWorldMindDecision(),
        rawDecisionJson: JSON.stringify(makeValidWorldMindDecision()),
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    expect(result.validationStatus).toBe("accepted");
    const characterStates = new CharacterStateRepository(db).listForWorld({ userId: "u001", worldId: "default" });
    expect(characterStates.map((state) => state.agentId)).toContain("agent-default");
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

    const decision = makeValidWorldMindDecision({
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          actorInstruction: "should not appear",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-nonexistent" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
    });

    const result = await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "hello", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });

    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt.type).toBe("user_action");
    expect((evt.payload as { interpretationStatus: string }).interpretationStatus).toBe("observed_only");
    expect((evt.payload as { failureReason: string }).failureReason).toBe("validation_failed");

    const snapshot = new WorldStateRepository(db).getLatest({ userId: "u001", worldId: "default" });
    expect(snapshot?.appliedEventSequence).toBe(1);
    expect(snapshot?.appliedEventIds).toEqual([evt.id]);

    const cmdRepo = new ActorCommandRepository(db);
    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ?")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(0);

    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("rejected");
    expect(logs[0].sourceEventId).toBe(evt.id);
    expect(logs[0].createdEventIdsJson).toEqual([evt.id]);
    expect(result.decisionLogId).toBe(logs[0].id);
    expect(result.createdEventIds).toEqual([evt.id]);
    expect(logs[0].rawDecisionJson).toContain('"commands"');
    expect(logs[0].validatedDecisionJson).toBeNull();
    expect(logs[0].validationErrorsJson.length).toBeGreaterThan(0);
    expect(logs[0].modelProvider).toBe("test");
    expect(logs[0].modelName).toBe("test-director");

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

    const result = await createWorldMindFlow({
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
    expect((evt.payload as { failureReason: string }).failureReason).toBe("model_failed");

    const snapshot = new WorldStateRepository(db).getLatest({ userId: "u001", worldId: "default" });
    expect(snapshot?.appliedEventSequence).toBe(1);
    expect(snapshot?.appliedEventIds).toEqual([evt.id]);

    const commands = db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE world_run_id = ?")
      .all(envelope.worldRunId) as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(0);

    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("model_failed");
    expect(logs[0].sourceEventId).toBe(evt.id);
    expect(logs[0].createdEventIdsJson).toEqual([evt.id]);
    expect(result.decisionLogId).toBe(logs[0].id);
    expect(result.createdEventIds).toEqual([evt.id]);
    expect(logs[0].modelProvider).toBe("mock");
    expect(logs[0].modelName).toBe("mock");
    expect(logs[0].rawDecisionJson).toBeNull();
    expect(logs[0].errorCode).toBe("MODEL_ERROR");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // transaction_failed — command repository throws during insert
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

    const decision = makeValidWorldMindDecision({
      events: [
        {
          clientEventId: "evt-derived-1",
          type: "world_incident",
          actorIds: ["agent-default"],
          payload: { title: "an incident", description: "something happened" },
          visibility: { mode: "public", visibleToActorIds: [] },
          summary: "an incident",
        },
      ],
      commands: [
        {
          commandType: "speak_to_user",
          targetAgentId: "agent-default",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [] },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "proposed_event", clientEventId: "evt-derived-1" },
          payload: {},
          relatedEventSummary: null,
        },
      ],
      observations: [],
      memories: [],
      nextTick: { delayMs: 60_000, reason: "test" },
    });

    // Enable the mock to throw on the next createMany call.
    shouldThrow.value = true;

    await expect(
      createWorldMindFlow({
        db,
        envelope,
        sourceInput: { message: "hello", targetAgentId: "agent-default" },
        generateDecision: async () => ({
          decision,
          rawDecisionJson: JSON.stringify(decision),
          modelProvider: "test",
          modelName: "test-director",
        }),
      }),
    ).rejects.toThrow("UNIQUE constraint failed");

    // The user_action is also rolled back — no committed events at all
    const eventRepo = new WorldEventRepository(db);
    const events = eventRepo.listCommitted({ userId: "u001", worldId: "default" });
    expect(events).toHaveLength(0);

    const snapshot = new WorldStateRepository(db).getLatest({ userId: "u001", worldId: "default" });
    expect(snapshot).toBeNull();

    // A best-effort transaction_failed decision log was written outside the tx
    const logRepo = new WorldDecisionLogRepository(db);
    const logs = logRepo.listForRun(envelope.worldRunId);
    expect(logs).toHaveLength(1);
    expect(logs[0].validationStatus).toBe("transaction_failed");
    expect(logs[0].modelProvider).toBe("test");
    expect(logs[0].modelName).toBe("test-director");
    expect(logs[0].rawDecisionJson).toContain('"intent"');
    expect(logs[0].errorCode).toBe("TRANSACTION_FAILED");

    const run = runRepo.getById(envelope.worldRunId);
    expect(run?.status).toBe("failed");
  });
});
