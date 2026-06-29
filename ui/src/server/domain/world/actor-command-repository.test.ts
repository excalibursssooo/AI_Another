import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ActorCommandRepository } from "./actor-command-repository";
import type { CreateActorCommandInput } from "./actor-command-repository";
import { WorldRunRepository } from "./world-run-repository";

function makeEnvelope(repo: WorldRunRepository) {
  return repo.createOrGet({
    userId: "u001",
    worldId: "default",
    agentId: "agent-default",
    sourceType: "user_action",
    sourceActionId: "client-1",
    idempotencyKey: `wrun:${Math.random()}`,
  });
}

function makeCommand(overrides: Partial<CreateActorCommandInput> = {}): CreateActorCommandInput {
  const now = Date.now();
  return {
    decisionId: "wdec-test",
    worldRunId: "wrun-test",
    userId: "u001",
    worldId: "default",
    targetAgentId: "agent-default",
    commandType: "move_location",
    priority: "normal",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    actorInstruction: "Move to the square.",
    privateReason: null,
    cause: { type: "director_no_event", reasonCode: "test" },
    payload: { locationKey: "square" },
    relatedEventId: null,
    runAfter: now,
    expiresAt: null,
    idempotencyKey: "cmd:test",
    ...overrides,
  };
}

describe("ActorCommandRepository", () => {
  describe("createMany", () => {
    it("inserts commands and returns records", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const result = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:1",
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toMatch(/^acmd-/);
      expect(result[0].status).toBe("pending");
    });

    it("returns existing record on duplicate idempotency key", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const first = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:dup",
        },
      ]);

      const second = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "high",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say different thing",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:dup",
        },
      ]);

      expect(second[0].id).toBe(first[0].id);
      expect(second[0].actorInstruction).toBe("say hello");
    });

    it("enforces the actor_commands SQL idempotency constraint below the repository layer", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:sql-unique",
        },
      ]);

      expect(() =>
        db.sqlite
          .prepare(
            `INSERT INTO actor_commands
              (id, decision_id, world_run_id, user_id, world_id, target_agent_id, command_type, priority,
               visibility, visible_to_actor_ids_json, visible_to_user, actor_instruction, private_reason,
               cause_json, payload_json, related_event_id, status, run_after, expires_at, idempotency_key,
               created_at, updated_at)
             VALUES
              ('acmd-sql-dupe', ?, ?, 'u001', 'default', 'agent-default', 'speak_to_user', 'normal',
               'public', '[]', 1, 'dupe', NULL, '{}', '{}', NULL, 'pending', 0, NULL, 'acmd:sql-unique',
               1, 1)`,
          )
          .run(envelope.decisionId, envelope.worldRunId),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });

  describe("claimVisibleSpeakCommand", () => {
    it("claims a pending speak_to_user command visible to user", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:claim1",
        },
      ]);

      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("claimed");
      expect(claimed!.claimedBy).toBe("agent-default");
      expect(claimed!.claimExpiresAt).toBeGreaterThan(Date.now());
    });

    it("does not claim a done command", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const [cmd] = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:claim2",
        },
      ]);

      repo.markDone({ commandId: cmd.id });
      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      expect(claimed).toBeNull();
    });

    it("returns null when no claimable commands exist", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: false },
          actorInstruction: "secret",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:claim3",
        },
      ]);

      // Not visible to user, and agentId doesn't match targetAgentId or visibleToActorIds
      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-wrong",
        claimedBy: "agent-wrong",
        leaseMs: 5000,
      });

      expect(claimed).toBeNull();
    });

    it("does not claim hidden commands even when targetAgentId matches", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "high",
          visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
          actorInstruction: "hidden instruction",
          privateReason: "director-only",
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:hidden",
        },
      ]);

      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      expect(claimed).toBeNull();
    });

    it("claims private commands only when the target actor is in the ACL", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "private", visibleToActorIds: ["agent-other"], visibleToUser: false },
          actorInstruction: "private for other",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:private-other",
        },
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
          actorInstruction: "private for default",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:private-default",
        },
      ]);

      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      expect(claimed?.actorInstruction).toBe("private for default");
    });

    it("claims high priority before normal before low", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      // Insert in reverse order
      for (const [priority, key] of [["low", "low"], ["normal", "normal"], ["high", "high"]] as const) {
        repo.createMany([
          {
            decisionId: envelope.decisionId,
            worldRunId: envelope.worldRunId,
            userId: "u001",
            worldId: "default",
            targetAgentId: "agent-default",
            commandType: "speak_to_user",
            priority,
            visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
            actorInstruction: key,
            privateReason: null,
            cause: { type: "source_action", sourceActionId: key },
            payload: {},
            relatedEventId: null,
            runAfter: 0,
            expiresAt: null,
            idempotencyKey: `acmd:priority-${key}`,
          },
        ]);
      }

      const claimed = repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      expect(claimed!.actorInstruction).toBe("high");
    });
  });

  describe("markDone", () => {
    it("marks a claimed command as done with resultEventId", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const [cmd] = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:done1",
        },
      ]);

      repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      const done = repo.markDone({ commandId: cmd.id, resultEventId: "evt-123" });
      expect(done).not.toBeNull();
      expect(done!.status).toBe("done");
      expect(done!.resultEventId).toBe("evt-123");
    });

    it("is idempotent - calling markDone twice returns same result", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const [cmd] = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:done2",
        },
      ]);

      repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      const first = repo.markDone({ commandId: cmd.id, resultEventId: "evt-1" });
      const second = repo.markDone({ commandId: cmd.id, resultEventId: "evt-2" });

      expect(first!.resultEventId).toBe("evt-1");
      expect(second!.resultEventId).toBe("evt-1"); // unchanged
    });
  });

  describe("releaseClaim", () => {
    it("releases a claim back to pending", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const [cmd] = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:release1",
        },
      ]);

      repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      const released = repo.releaseClaim({ commandId: cmd.id, claimedBy: "agent-default" });
      expect(released).not.toBeNull();
      expect(released!.status).toBe("pending");
      expect(released!.claimedBy).toBeNull();
    });

    it("returns null if claimedBy does not match", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new ActorCommandRepository(db);
      const envelope = makeEnvelope(runRepo);

      const [cmd] = repo.createMany([
        {
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          targetAgentId: "agent-default",
          commandType: "speak_to_user",
          priority: "normal",
          visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
          actorInstruction: "say hello",
          privateReason: null,
          cause: { type: "source_action", sourceActionId: "client-1" },
          payload: {},
          relatedEventId: null,
          runAfter: 0,
          expiresAt: null,
          idempotencyKey: "acmd:release2",
        },
      ]);

      repo.claimVisibleSpeakCommand({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
        claimedBy: "agent-default",
        leaseMs: 5000,
      });

      const released = repo.releaseClaim({ commandId: cmd.id, claimedBy: "agent-other" });
      expect(released).toBeNull();
    });
  });

  describe("worker command claims", () => {
    it("claims due non-speak commands for workers and skips speak_to_user", () => {
      const db = createTestDatabase();
      const repo = new ActorCommandRepository(db);
      repo.createMany([
        makeCommand({ commandType: "speak_to_user", idempotencyKey: "cmd:speak" }),
        makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" }),
      ]);

      const claimed = repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 30_000 });

      expect(claimed?.commandType).toBe("move_location");
      expect(claimed?.status).toBe("claimed");
      expect(claimed?.claimedBy).toBe("actor-worker");
      expect(repo.claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 })).toBeNull();
    });

    it("reclaims worker commands after claim expiry", () => {
      const db = createTestDatabase();
      const repo = new ActorCommandRepository(db);
      const [command] = repo.createMany([makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" })]);
      repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 1 });
      db.sqlite.prepare("UPDATE actor_commands SET claim_expires_at = ? WHERE id = ?").run(Date.now() - 1_000, command.id);

      const reclaimed = repo.claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 });

      expect(reclaimed?.id).toBe(command.id);
      expect(reclaimed?.claimedBy).toBe("actor-worker-2");
    });

    it("marks claimed commands failed with worker ownership", () => {
      const db = createTestDatabase();
      const repo = new ActorCommandRepository(db);
      const [command] = repo.createMany([makeCommand({ commandType: "move_location", idempotencyKey: "cmd:move" })]);
      repo.claimNextExecutableCommand({ workerId: "actor-worker", leaseMs: 30_000 });

      const failed = repo.markFailed({ commandId: command.id, claimedBy: "actor-worker", reason: "bad payload" });

      expect(failed?.status).toBe("failed");
      expect(failed?.privateReason).toContain("bad payload");
    });
  });
});
