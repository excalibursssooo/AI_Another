import { embedText as defaultEmbedText } from "@/server/ai/embeddings";
import type { AppDatabase } from "@/server/db/client";
import type { EmbedText } from "@/server/domain/chat/memory-consolidator";

import type { WorldMemoryCandidate } from "./world-decision";
import type { WorldMemoryConsolidationResult, WorldMemoryVisibility } from "./types";
import { WorldMemoryRepository } from "./world-memory-repository";

export class WorldMemoryConsolidator {
  private readonly memories: WorldMemoryRepository;
  private readonly embedText: EmbedText;

  constructor(input: { db: AppDatabase; embedText?: EmbedText }) {
    this.memories = new WorldMemoryRepository(input.db);
    this.embedText = input.embedText ?? defaultEmbedText;
  }

  async consolidate(input: {
    userId: string;
    worldId: string;
    sourceDecisionId: string;
    currentTick: number;
    candidates: WorldMemoryCandidate[];
  }): Promise<WorldMemoryConsolidationResult[]> {
    const results: WorldMemoryConsolidationResult[] = [];
    for (const candidate of input.candidates) {
      results.push(await this.consolidateOne({ ...input, candidate }));
    }
    return results;
  }

  private async consolidateOne(input: {
    userId: string;
    worldId: string;
    sourceDecisionId: string;
    currentTick: number;
    candidate: WorldMemoryCandidate;
  }): Promise<WorldMemoryConsolidationResult> {
    const { candidate } = input;
    if (candidate.sourceEventId == null) {
      return { action: "skipped", reason: "source_event_id_required" };
    }

    const embedding = await this.embedText(candidate.content);
    const createInput = {
      userId: input.userId,
      worldId: input.worldId,
      subjectType: candidate.subjectType,
      subjectKey: candidate.subjectKey,
      memoryType: candidate.memoryType,
      canonicalKey: candidate.canonicalKey,
      content: candidate.content,
      visibility: candidate.visibility.mode as WorldMemoryVisibility,
      visibleToActorIds: candidate.visibility.visibleToActorIds,
      visibleToUser: candidate.visibility.visibleToUser,
      importance: candidate.importance,
      confidence: candidate.confidence,
      validFromTick: input.currentTick,
      sourceEventId: candidate.sourceEventId,
      sourceDecisionId: input.sourceDecisionId,
      supersededBy: null,
      embeddingJson: JSON.stringify(embedding.vector),
      embeddingQuality: embedding.quality,
    };

    if (!candidate.canonicalKey) {
      const created = this.memories.create(createInput);
      return { action: "created", memoryId: created.id, reason: "no_canonical_key" };
    }

    const existing = this.memories.findActiveByCanonicalKey({
      userId: input.userId,
      worldId: input.worldId,
      memoryType: candidate.memoryType,
      canonicalKey: candidate.canonicalKey,
    });

    if (!existing) {
      const created = this.memories.create(createInput);
      return { action: "created", memoryId: created.id, reason: "new_canonical_key" };
    }

    if (candidate.memoryType === "unresolved_thread") {
      const created = this.memories.create({
        ...createInput,
        content: `${existing.content}\n- tick ${input.currentTick}: ${candidate.content}`,
      });
      this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
      return {
        action: "appended",
        memoryId: created.id,
        supersededMemoryId: existing.id,
        reason: "thread_timeline_appended",
      };
    }

    if (candidate.memoryType === "rule" || candidate.memoryType === "secret" || candidate.memoryType === "relationship") {
      const created = this.memories.create(createInput);
      this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
      return {
        action: "superseded",
        memoryId: created.id,
        supersededMemoryId: existing.id,
        reason: `${candidate.memoryType}_canonical_replacement`,
      };
    }

    if (candidate.memoryType === "lore") {
      if (candidate.confidence >= existing.confidence && candidate.importance >= existing.importance) {
        const created = this.memories.create(createInput);
        this.memories.supersede({ memoryId: existing.id, supersededBy: created.id });
        return { action: "superseded", memoryId: created.id, supersededMemoryId: existing.id, reason: "lore_higher_quality" };
      }
      return { action: "skipped", memoryId: existing.id, reason: "lore_existing_quality_wins" };
    }

    return { action: "skipped", memoryId: existing.id, reason: "unknown_memory_type" };
  }
}
