import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { CharacterStateRepository } from "./character-state-repository";

describe("CharacterStateRepository", () => {
  describe("getOrCreateDefault", () => {
    it("returns default state for a new character", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      const state = repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
      });

      expect(state.userId).toBe("u001");
      expect(state.worldId).toBe("default");
      expect(state.agentId).toBe("agent-default");
      expect(state.locationKey).toBe("default");
      expect(state.currentGoal).toBe("保持当前互动并等待世界指令");
      expect(state.emotionalState).toEqual({ label: "neutral", intensity: 0.35 });
      expect(state.relationshipToUser).toEqual({ affinity: 0, trust: 0, tension: 0 });
      expect(state.knowledgeKeys).toEqual([]);
      expect(state.activeCommandId).toBeNull();
      expect(state.lastActedAt).toBeNull();
      expect(state.updatedAt).toBeDefined();
    });

    it("returns the same default state on repeated calls without modification", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      const first = repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
      });
      const second = repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
      });

      expect(second.locationKey).toBe("default");
      expect(second.currentGoal).toBe("保持当前互动并等待世界指令");
      expect(second.updatedAt).toBe(first.updatedAt);
    });

    it("returns existing record unchanged if found", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
      });
      // Upsert a modified state
      repo.upsertMany([
        {
          userId: "u001",
          worldId: "default",
          agentId: "agent-default",
          locationKey: "dojo",
          currentGoal: "practice sword forms",
          emotionalState: { label: "focused", intensity: 0.8 },
          relationshipToUser: { affinity: 5, trust: 3, tension: 1 },
          knowledgeKeys: ["swordsmanship", "martial_arts"],
          activeCommandId: null,
          lastActedAt: null,
          updatedAt: Date.now(),
        },
      ]);

      const existing = repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-default",
      });

      // Should return the upserted state, not the default
      expect(existing.locationKey).toBe("dojo");
      expect(existing.currentGoal).toBe("practice sword forms");
      expect(existing.emotionalState.label).toBe("focused");
    });
  });

  describe("listForWorld", () => {
    it("returns all characters for a given user and world", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      repo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-1" });
      repo.getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-2" });
      repo.getOrCreateDefault({ userId: "u002", worldId: "default", agentId: "agent-1" });

      const u001Default = repo.listForWorld({ userId: "u001", worldId: "default" });
      expect(u001Default).toHaveLength(2);
      const agentIds = u001Default.map((s) => s.agentId).sort();
      expect(agentIds).toEqual(["agent-1", "agent-2"]);
    });

    it("returns empty array when no characters exist", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      const result = repo.listForWorld({ userId: "u999", worldId: "default" });
      expect(result).toEqual([]);
    });
  });

  describe("upsertMany", () => {
    it("inserts new records", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      const result = repo.upsertMany([
        {
          userId: "u001",
          worldId: "default",
          agentId: "agent-new",
          locationKey: "forest",
          currentGoal: "explore",
          emotionalState: { label: "curious", intensity: 0.6 },
          relationshipToUser: { affinity: 1, trust: 0, tension: 0 },
          knowledgeKeys: ["navigation"],
          activeCommandId: null,
          lastActedAt: null,
          updatedAt: Date.now(),
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].locationKey).toBe("forest");
    });

    it("updates existing records", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      repo.getOrCreateDefault({
        userId: "u001",
        worldId: "default",
        agentId: "agent-update",
      });

      const result = repo.upsertMany([
        {
          userId: "u001",
          worldId: "default",
          agentId: "agent-update",
          locationKey: "village",
          currentGoal: "talk to villagers",
          emotionalState: { label: "friendly", intensity: 0.5 },
          relationshipToUser: { affinity: 2, trust: 1, tension: 0 },
          knowledgeKeys: [],
          activeCommandId: "cmd-123",
          lastActedAt: 9999999,
          updatedAt: Date.now(),
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].locationKey).toBe("village");
      expect(result[0].activeCommandId).toBe("cmd-123");
    });

    it("upserts multiple records in one call", () => {
      const repo = new CharacterStateRepository(createTestDatabase());
      const result = repo.upsertMany([
        {
          userId: "u001",
          worldId: "default",
          agentId: "agent-a",
          locationKey: "home",
          currentGoal: "wait",
          emotionalState: { label: "neutral", intensity: 0.3 },
          relationshipToUser: { affinity: 0, trust: 0, tension: 0 },
          knowledgeKeys: [],
          activeCommandId: null,
          lastActedAt: null,
          updatedAt: Date.now(),
        },
        {
          userId: "u001",
          worldId: "default",
          agentId: "agent-b",
          locationKey: "shop",
          currentGoal: "buy items",
          emotionalState: { label: "excited", intensity: 0.7 },
          relationshipToUser: { affinity: 3, trust: 2, tension: 0 },
          knowledgeKeys: ["trading"],
          activeCommandId: null,
          lastActedAt: null,
          updatedAt: Date.now(),
        },
      ]);

      expect(result).toHaveLength(2);
    });
  });
});
