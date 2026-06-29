import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import type { WorldMemoryCandidate } from "./world-decision";
import { WorldMemoryConsolidator } from "./world-memory-consolidator";
import { WorldMemoryRepository } from "./world-memory-repository";

function candidate(overrides: Partial<WorldMemoryCandidate> = {}): WorldMemoryCandidate {
  return {
    subjectType: "world",
    subjectKey: "default",
    memoryType: "rule",
    canonicalKey: "rule:weather",
    content: "Rain makes the old city gates open late.",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    importance: 0.8,
    confidence: 0.9,
    sourceEventId: "wevt-source",
    ...overrides,
  };
}

const embedTextStub = async () => ({
  vector: [1, 0],
  dimension: 2,
  backend: "fallback" as const,
  quality: "lexical" as const,
  model: "test",
  version: 1,
  needsRefresh: true,
});

describe("WorldMemoryConsolidator", () => {
  it("supersedes rule memories with the same canonical key", async () => {
    const db = createTestDatabase();
    const repo = new WorldMemoryRepository(db);
    const existing = repo.create({
      userId: "u001",
      worldId: "default",
      subjectType: "world",
      subjectKey: "default",
      memoryType: "rule",
      canonicalKey: "rule:weather",
      content: "Rain closes the old city gates.",
      visibility: "public",
      visibleToActorIds: [],
      visibleToUser: true,
      importance: 0.6,
      confidence: 0.7,
      validFromTick: 1,
      sourceEventId: "wevt-old",
      sourceDecisionId: "wdec-old",
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    const result = await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 2,
      candidates: [candidate({ content: "Rain makes the old city gates open late." })],
    });

    expect(result).toEqual([expect.objectContaining({ action: "superseded", supersededMemoryId: existing.id })]);
    const active = repo.findActiveByCanonicalKey({
      userId: "u001",
      worldId: "default",
      memoryType: "rule",
      canonicalKey: "rule:weather",
    });
    expect(active?.content).toBe("Rain makes the old city gates open late.");
    expect(repo.getById(existing.id)?.supersededBy).toBe(active?.id);
  });

  it("appends unresolved_thread memories by canonical key", async () => {
    const db = createTestDatabase();
    const repo = new WorldMemoryRepository(db);
    repo.create({
      userId: "u001",
      worldId: "default",
      subjectType: "world",
      subjectKey: "default",
      memoryType: "unresolved_thread",
      canonicalKey: "thread:gate",
      content: "- tick 1: The gate lock was missing.",
      visibility: "hidden",
      visibleToActorIds: [],
      visibleToUser: false,
      importance: 0.7,
      confidence: 0.8,
      validFromTick: 1,
      sourceEventId: "wevt-old",
      sourceDecisionId: "wdec-old",
      supersededBy: null,
      embeddingJson: null,
      embeddingQuality: null,
    });

    await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 3,
      candidates: [
        candidate({
          memoryType: "unresolved_thread",
          canonicalKey: "thread:gate",
          content: "The captain asked who last held the key.",
          visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
        }),
      ],
    });

    const active = repo.findActiveByCanonicalKey({
      userId: "u001",
      worldId: "default",
      memoryType: "unresolved_thread",
      canonicalKey: "thread:gate",
    });
    expect(active?.content).toContain("tick 1");
    expect(active?.content).toContain("tick 3");
  });

  it("skips candidates derived from world activity without source event id", async () => {
    const db = createTestDatabase();
    const result = await new WorldMemoryConsolidator({ db, embedText: embedTextStub }).consolidate({
      userId: "u001",
      worldId: "default",
      sourceDecisionId: "wdec-new",
      currentTick: 3,
      candidates: [candidate({ sourceEventId: null })],
    });

    expect(result[0]).toEqual(expect.objectContaining({ action: "skipped", reason: "source_event_id_required" }));
  });
});
