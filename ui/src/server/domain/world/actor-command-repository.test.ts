import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ActorCommandRepository } from "./actor-command-repository";
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: false },
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
            visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
          visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
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
});
