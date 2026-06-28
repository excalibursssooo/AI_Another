import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldDecisionLogRepository } from "./world-decision-log-repository";
import { WorldRunRepository } from "./world-run-repository";

function makeEnvelope(repo: WorldRunRepository) {
  return repo.createOrGet({
    userId: "u001",
    worldId: "default",
    agentId: "agent-default",
    sourceType: "user_action",
    sourceActionId: "client-1",
    idempotencyKey: `wdl-run:${Math.random()}`,
  });
}

describe("WorldDecisionLogRepository", () => {
  describe("insert", () => {
    it("inserts an accepted decision log with all fields", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new WorldDecisionLogRepository(db);
      const envelope = makeEnvelope(runRepo);

      const record = repo.insert({
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId: "u001",
        worldId: "default",
        sourceType: "user_action",
        sourceEventId: "evt-001",
        sourceTaskId: null,
        modelProvider: "openai",
        modelName: "gpt-4o",
        promptContextHash: "abc123",
        rawDecisionJson: '{"action":"speak","text":"hello"}',
        validatedDecisionJson: '{"action":"speak","text":"hello"}',
        validationStatus: "accepted",
        validationErrorsJson: [],
        errorCode: null,
        errorMessage: null,
        createdEventIdsJson: ["evt-001"],
        createdCommandIdsJson: ["cmd-001"],
      });

      expect(record.id).toMatch(/^wdl-/);
      expect(record.decisionId).toBe(envelope.decisionId);
      expect(record.worldRunId).toBe(envelope.worldRunId);
      expect(record.validationStatus).toBe("accepted");
      expect(record.createdEventIdsJson).toEqual(["evt-001"]);
      expect(record.createdCommandIdsJson).toEqual(["cmd-001"]);
      expect(record.createdAt).toBeGreaterThan(0);
    });

    it("inserts a transaction_failed log", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new WorldDecisionLogRepository(db);
      const envelope = makeEnvelope(runRepo);

      const record = repo.insert({
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId: "u001",
        worldId: "default",
        sourceType: "user_action",
        sourceEventId: null,
        sourceTaskId: "task-001",
        modelProvider: "openai",
        modelName: "gpt-4o",
        promptContextHash: "abc123",
        rawDecisionJson: null,
        validatedDecisionJson: null,
        validationStatus: "transaction_failed",
        validationErrorsJson: ["slot_conflict: location already occupied"],
        errorCode: "SLOT_CONFLICT",
        errorMessage: "slot conflict",
        createdEventIdsJson: [],
        createdCommandIdsJson: [],
      });

      expect(record.validationStatus).toBe("transaction_failed");
      expect(record.errorCode).toBe("SLOT_CONFLICT");
      expect(record.validationErrorsJson).toEqual(["slot_conflict: location already occupied"]);
    });

    it("never throws on null/undefined array fields during insert", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new WorldDecisionLogRepository(db);
      const envelope = makeEnvelope(runRepo);

      // These would throw JSON.stringify on null/undefined — the repo must handle it
      expect(() =>
        repo.insert({
          decisionId: envelope.decisionId,
          worldRunId: envelope.worldRunId,
          userId: "u001",
          worldId: "default",
          sourceType: "user_action",
          sourceEventId: null,
          sourceTaskId: null,
          modelProvider: "openai",
          modelName: "gpt-4o",
          promptContextHash: "abc",
          rawDecisionJson: null,
          validatedDecisionJson: null,
          validationStatus: "rejected",
          validationErrorsJson: null as unknown as [],
          errorCode: null,
          errorMessage: null,
          createdEventIdsJson: null as unknown as [],
          createdCommandIdsJson: undefined as unknown as [],
        }),
      ).not.toThrow();
    });
  });

  describe("listForRun", () => {
    it("returns all decision logs for a world run", () => {
      const db = createTestDatabase();
      const runRepo = new WorldRunRepository(db);
      const repo = new WorldDecisionLogRepository(db);
      const envelope1 = makeEnvelope(runRepo);
      const envelope2 = makeEnvelope(runRepo);

      repo.insert({
        decisionId: envelope1.decisionId,
        worldRunId: envelope1.worldRunId,
        userId: "u001",
        worldId: "default",
        sourceType: "user_action",
        sourceEventId: null,
        sourceTaskId: null,
        modelProvider: "openai",
        modelName: "gpt-4o",
        promptContextHash: "h1",
        rawDecisionJson: null,
        validatedDecisionJson: null,
        validationStatus: "accepted",
        validationErrorsJson: [],
        errorCode: null,
        errorMessage: null,
        createdEventIdsJson: [],
        createdCommandIdsJson: [],
      });

      repo.insert({
        decisionId: envelope2.decisionId,
        worldRunId: envelope2.worldRunId,
        userId: "u001",
        worldId: "default",
        sourceType: "user_action",
        sourceEventId: null,
        sourceTaskId: null,
        modelProvider: "openai",
        modelName: "gpt-4o",
        promptContextHash: "h2",
        rawDecisionJson: null,
        validatedDecisionJson: null,
        validationStatus: "accepted",
        validationErrorsJson: [],
        errorCode: null,
        errorMessage: null,
        createdEventIdsJson: [],
        createdCommandIdsJson: [],
      });

      const logs = repo.listForRun(envelope1.worldRunId);
      expect(logs).toHaveLength(1);
      expect(logs[0].worldRunId).toBe(envelope1.worldRunId);
    });

    it("returns empty array for unknown world run", () => {
      const db = createTestDatabase();
      const repo = new WorldDecisionLogRepository(db);
      const logs = repo.listForRun("wrun-unknown");
      expect(logs).toEqual([]);
    });
  });
});
