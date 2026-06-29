import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldMemoryRepository } from "./world-memory-repository";

describe("WorldMemoryRepository", () => {
  describe("create", () => {
    it("creates a seed lore memory without sourceEventId", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());
      const memory = repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "ancient_forest",
        memoryType: "lore",
        canonicalKey: "lore:ancient_forest",
        content: "The ancient forest has stood for a thousand years.",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.9,
        confidence: 1.0,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      expect(memory.id).toMatch(/^wmem-/);
      expect(memory.memoryType).toBe("lore");
      expect(memory.sourceEventId).toBeNull();
      expect(memory.content).toBe("The ancient forest has stood for a thousand years.");
    });

    it("throws when creating a non-lore memory without sourceEventId", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());
      expect(() =>
        repo.create({
          userId: "u001",
          worldId: "default",
          subjectType: "arc",
          subjectKey: "battle_001",
          memoryType: "unresolved_thread",
          canonicalKey: null,
          content: "A great battle occurred.",
          visibility: "public",
          visibleToActorIds: [],
          visibleToUser: true,
          importance: 0.8,
          confidence: 0.9,
          validFromTick: 42,
          sourceEventId: null,
          sourceDecisionId: null,
          supersededBy: null,
          embeddingJson: null,
          embeddingQuality: null,
        }),
      ).toThrow("sourceEventId is required for memories derived from world activity");
    });

    it("throws when creating a lore memory from world activity without sourceEventId", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());
      expect(() =>
        repo.create({
          userId: "u001",
          worldId: "default",
          subjectType: "lore",
          subjectKey: "battle_001",
          memoryType: "lore",
          canonicalKey: null,
          content: "A great battle became local lore.",
          visibility: "public",
          visibleToActorIds: [],
          visibleToUser: true,
          importance: 0.8,
          confidence: 0.9,
          validFromTick: 42,
          sourceEventId: null,
          sourceDecisionId: "wdec-001",
          supersededBy: null,
          embeddingJson: null,
          embeddingQuality: null,
        }),
      ).toThrow("sourceEventId is required for memories derived from world activity");
    });

    it("rejects event as a memory type", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());
      expect(() =>
        repo.create({
          userId: "u001",
          worldId: "default",
          subjectType: "world",
          subjectKey: "event_001",
          memoryType: "event",
          canonicalKey: null,
          content: "Events belong in world_events.",
          visibility: "public",
          visibleToActorIds: [],
          visibleToUser: true,
          importance: 0.5,
          confidence: 0.9,
          validFromTick: 1,
          sourceEventId: "evt-001",
          sourceDecisionId: "wdec-001",
          supersededBy: null,
          embeddingJson: null,
          embeddingQuality: null,
        }),
      ).toThrow("event is not a world memory type");
    });

    it("creates a derived memory with sourceEventId", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());
      const memory = repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "arc",
        subjectKey: "battle_001",
        memoryType: "unresolved_thread",
        canonicalKey: null,
        content: "A great battle occurred.",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.8,
        confidence: 0.9,
        validFromTick: 42,
        sourceEventId: "evt-001",
        sourceDecisionId: "wdec-001",
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      expect(memory.id).toMatch(/^wmem-/);
      expect(memory.sourceEventId).toBe("evt-001");
      expect(memory.memoryType).toBe("unresolved_thread");
    });
  });

  describe("recallForDirector", () => {
    it("returns all memories including hidden for the director", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "secret_door",
        memoryType: "lore",
        canonicalKey: null,
        content: "There is a secret door behind the waterfall.",
        visibility: "hidden",
        visibleToActorIds: [],
        visibleToUser: false,
        importance: 0.7,
        confidence: 0.95,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "public_fact",
        memoryType: "lore",
        canonicalKey: null,
        content: "The town square is the heart of the village.",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.6,
        confidence: 0.9,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      const memories = repo.recallForDirector({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
      });

      expect(memories).toHaveLength(2);
    });

    it("filters by subjectType and optionally subjectKey", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "key1",
        memoryType: "lore",
        canonicalKey: null,
        content: "lore 1",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.5,
        confidence: 0.5,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "arc",
        subjectKey: "key2",
        memoryType: "unresolved_thread",
        canonicalKey: null,
        content: "event 1",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.5,
        confidence: 0.5,
        validFromTick: 0,
        sourceEventId: "evt-001",
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      const loreMemories = repo.recallForDirector({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
      });

      expect(loreMemories).toHaveLength(1);
      expect(loreMemories[0].subjectType).toBe("lore");

      const keyedMemories = repo.recallForDirector({
        userId: "u001",
        worldId: "default",
        subjectType: "arc",
        subjectKey: "key2",
      });

      expect(keyedMemories).toHaveLength(1);
      expect(keyedMemories[0].subjectKey).toBe("key2");
    });

    it("excludes superseded memories", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "hero_name",
        memoryType: "lore",
        canonicalKey: null,
        content: "The hero is named Arin.",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.7,
        confidence: 0.8,
        validFromTick: 10,
        sourceEventId: "evt-old-hero-name",
        sourceDecisionId: null,
        supersededBy: "wmem-new",
        embeddingJson: null,
        embeddingQuality: null,
      });

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "hero_name",
        memoryType: "lore",
        canonicalKey: null,
        content: "The hero is named Kael.",
        visibility: "public",
        visibleToActorIds: [],
        visibleToUser: true,
        importance: 0.7,
        confidence: 0.9,
        validFromTick: 20,
        sourceEventId: "evt-new-hero-name",
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      const memories = repo.recallForDirector({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "hero_name",
      });

      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe("The hero is named Kael.");
    });
  });

  describe("recallForActor", () => {
    it("excludes hidden memories even when actor is in visibleToActorIds", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "hidden_secret",
        memoryType: "lore",
        canonicalKey: null,
        content: "The king is actually a fraud.",
        visibility: "hidden",
        visibleToActorIds: ["agent-trusted"],
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

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "another_secret",
        memoryType: "lore",
        canonicalKey: null,
        content: "Another secret for agent only.",
        visibility: "hidden",
        visibleToActorIds: ["agent-other"],
        visibleToUser: false,
        importance: 0.8,
        confidence: 0.9,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      const allActorMemories = repo.recallForActor({
        userId: "u001",
        worldId: "default",
        agentId: "agent-trusted",
        subjectType: "lore",
      });

      expect(allActorMemories).toHaveLength(0);

      const otherActorMemories = repo.recallForActor({
        userId: "u001",
        worldId: "default",
        agentId: "agent-other",
        subjectType: "lore",
      });

      expect(otherActorMemories).toHaveLength(0);

      const untrustedActorMemories = repo.recallForActor({
        userId: "u001",
        worldId: "default",
        agentId: "agent-untrusted",
        subjectType: "lore",
      });

      expect(untrustedActorMemories).toHaveLength(0);
    });

    it("excludes private memories unless actor ACL allows them", () => {
      const repo = new WorldMemoryRepository(createTestDatabase());

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "public_fact",
        memoryType: "lore",
        canonicalKey: null,
        content: "The sun rises in the east.",
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

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "private_note_for_other",
        memoryType: "lore",
        canonicalKey: null,
        content: "The hero has a scar on their left hand.",
        visibility: "private",
        visibleToActorIds: ["agent-other"],
        visibleToUser: false,
        importance: 0.6,
        confidence: 0.8,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      repo.create({
        userId: "u001",
        worldId: "default",
        subjectType: "lore",
        subjectKey: "private_note_for_agent",
        memoryType: "lore",
        canonicalKey: null,
        content: "The actor knows the private signal.",
        visibility: "private",
        visibleToActorIds: ["agent-any"],
        visibleToUser: false,
        importance: 0.6,
        confidence: 0.8,
        validFromTick: 0,
        sourceEventId: null,
        sourceDecisionId: null,
        supersededBy: null,
        embeddingJson: null,
        embeddingQuality: null,
      });

      const memories = repo.recallForActor({
        userId: "u001",
        worldId: "default",
        agentId: "agent-any",
        subjectType: "lore",
      });

      expect(memories).toHaveLength(2);
      expect(memories.map((memory) => memory.subjectKey).sort()).toEqual(["private_note_for_agent", "public_fact"]);
    });
  });
});
