import type { AppDatabase } from "@/server/db/client";
import {
  embedText as defaultEmbedText,
  cosineSimilarity,
  hashEmbeddingText,
} from "@/server/ai/embeddings";
import type { EmbeddingResult } from "@/server/ai/embeddings";
import type { MemoryCandidate } from "@/server/ai/schemas";
import { MemoryRecord, MemoryRepository } from "./repositories";

export const MEMORY_MERGE_SIMILARITY = 0.86;
export const MEMORY_CONFLICT_SIMILARITY = 0.72;
export const MEMORY_MERGED_CONTENT_MAX_LENGTH = 500;
export const MEMORY_CONFLICT_TOP_K = 10;

export type ConsolidationAction = "created" | "merged" | "conflicted" | "skipped";

export interface ConsolidateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  candidate: MemoryCandidate;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
}

export interface ConsolidationResult {
  action: ConsolidationAction;
  memoryId?: string;
  frozenMemoryId?: string;
  reason: string;
}

type EmbedText = typeof defaultEmbedText;

interface RankedMemory {
  memory: MemoryRecord;
  similarity: number;
}

const POSITIVE_PHRASES = ["喜欢", "爱", "想", "要", "希望", "倾向"];
const NEGATIVE_PHRASES = ["不喜欢", "不爱", "不想", "不要", "不希望", "讨厌", "排斥"];

export class MemoryConsolidator {
  private readonly memories: MemoryRepository;
  private readonly embedText: EmbedText;

  constructor(options: { db: AppDatabase; embedText?: EmbedText }) {
    this.memories = new MemoryRepository(options.db);
    this.embedText = options.embedText ?? defaultEmbedText;
  }

  async consolidate(input: ConsolidateMemoryInput): Promise<ConsolidationResult> {
    const content = input.candidate.content.trim();
    if (!content) {
      return { action: "skipped", reason: "empty content" };
    }

    const embedding = await this.embedText(content);
    const embeddingInput = toEmbeddingInput(content, embedding);
    const comparable = this.memories
      .listActiveForScope(input)
      .filter((memory) => isComparable(memory, input.candidate));

    const ranked = rankComparable(comparable, embedding);
    const conflict = ranked
      .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
      .slice(0, MEMORY_CONFLICT_TOP_K)
      .find((item) => detectConflict(item.memory.content, content, input.candidate.type));

    if (conflict) {
      const created = this.memories.replaceConflicted({
        oldMemoryId: conflict.memory.id,
        reason: "deterministic conflict",
        newMemory: {
          userId: input.userId,
          agentId: input.agentId,
          worldId: input.worldId,
          subject: input.candidate.subject,
          memoryType: input.candidate.type,
          key: input.candidate.key,
          topic: input.candidate.topic,
          content,
          importance: input.candidate.importance,
          confidence: input.candidate.confidence,
          embedding: embeddingInput,
          sourceMessageId: input.sourceMessageId,
          sourceTaskId: input.sourceTaskId,
          lastObservedAt: Date.now(),
        },
      });
      return {
        action: "conflicted",
        memoryId: created.id,
        frozenMemoryId: conflict.memory.id,
        reason: "conflict",
      };
    }

    const best = ranked[0];
    if (best && best.similarity >= MEMORY_MERGE_SIMILARITY) {
      const mergedContent = mergeMemoryContent(best.memory, input.candidate);
      const mergedEmbedding = await this.embedText(mergedContent);
      const updated = this.memories.mergeMemory({
        memoryId: best.memory.id,
        content: mergedContent,
        importance: Math.max(best.memory.importance, input.candidate.importance),
        confidence: Math.max(best.memory.confidence, input.candidate.confidence),
        key: input.candidate.key ?? best.memory.key,
        topic: input.candidate.topic ?? best.memory.topic,
        embedding: toEmbeddingInput(mergedContent, mergedEmbedding),
        lastObservedAt: Date.now(),
      });
      return { action: "merged", memoryId: updated?.id, reason: "similar semantic memory" };
    }

    const created = this.memories.create({
      userId: input.userId,
      agentId: input.agentId,
      worldId: input.worldId,
      subject: input.candidate.subject,
      memoryType: input.candidate.type,
      key: input.candidate.key,
      topic: input.candidate.topic,
      content,
      importance: input.candidate.importance,
      confidence: input.candidate.confidence,
      embedding: embeddingInput,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      lastObservedAt: Date.now(),
    });
    return { action: "created", memoryId: created.id, reason: "no comparable semantic memory" };
  }

  detectConflictForTest(oldContent: string, newContent: string, memoryType: string): boolean {
    return detectConflict(oldContent, newContent, memoryType);
  }
}

function toEmbeddingInput(content: string, result: EmbeddingResult) {
  return {
    json: JSON.stringify(result.vector),
    model: result.model,
    backend: result.backend,
    quality: result.quality,
    dimension: result.dimension,
    status: result.quality === "semantic" ? ("ready" as const) : ("fallback" as const),
    textHash: hashEmbeddingText(content),
    version: result.version,
    needsRefresh: result.needsRefresh,
    updatedAt: Date.now(),
  };
}

function isComparable(memory: MemoryRecord, candidate: MemoryCandidate): boolean {
  if (memory.subject !== candidate.subject) {
    return false;
  }
  if (memory.memoryType !== candidate.type) {
    return false;
  }
  return true;
}

function rankComparable(memories: MemoryRecord[], candidateEmbedding: EmbeddingResult): RankedMemory[] {
  if (candidateEmbedding.quality !== "semantic") {
    return [];
  }
  const ranked: RankedMemory[] = [];
  for (const memory of memories) {
    if (memory.embeddingQuality !== "semantic") {
      continue;
    }
    const vector = parseVector(memory.embeddingJson);
    if (!vector) {
      continue;
    }
    const similarity = cosineSimilarity(vector, candidateEmbedding.vector);
    if (similarity === null) {
      continue;
    }
    ranked.push({ memory, similarity });
  }
  ranked.sort((a, b) => b.similarity - a.similarity);
  return ranked;
}

function parseVector(raw: string | null): number[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.every((item) => typeof item === "number")) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

function detectConflict(oldContent: string, newContent: string, memoryType: string): boolean {
  if (memoryType !== "preference") {
    return false;
  }
  const oldPolarity = polarityOf(oldContent);
  const newPolarity = polarityOf(newContent);

  if (oldPolarity === null || newPolarity === null) {
    return false;
  }
  return oldPolarity !== newPolarity;
}

function polarityOf(content: string): "positive" | "negative" | null {
  // Match negative phrases first (per design rule). A negative phrase match
  // classifies the content as negative; a positive phrase inside a negative
  // phrase (e.g. "喜欢" in "不喜欢") is therefore ignored, so "不是不喜欢"
  // is treated as negative — not as both.
  for (const phrase of NEGATIVE_PHRASES) {
    if (content.includes(phrase)) {
      return "negative";
    }
  }
  for (const phrase of POSITIVE_PHRASES) {
    if (content.includes(phrase)) {
      return "positive";
    }
  }
  return null;
}

function mergeMemoryContent(memory: MemoryRecord, candidate: MemoryCandidate): string {
  const oldContent = memory.content.trim();
  const newContent = candidate.content.trim();

  if (!oldContent) {
    return clampContent(newContent);
  }
  if (!newContent) {
    return clampContent(oldContent);
  }
  if (oldContent.includes(newContent)) {
    return clampContent(oldContent);
  }
  if (newContent.includes(oldContent)) {
    return clampContent(newContent);
  }
  return clampContent(appendByType(oldContent, newContent, candidate.type));
}

function appendByType(oldContent: string, newContent: string, memoryType: string): string {
  switch (memoryType) {
    case "preference":
      return `${oldContent}\n补充：${newContent}`;
    case "boundary":
      return `${oldContent}\n附加约束：${newContent}`;
    case "relationship":
      return `${oldContent}\n补充：${newContent}`;
    case "profile":
      return `${oldContent}\n补充：${newContent}`;
    case "goal":
      return `${oldContent}\n进展：${newContent}`;
    case "event":
      return `${oldContent}\n后续：${newContent}`;
    case "lore":
      return `${oldContent}\n补充：${newContent}`;
    default:
      return `${oldContent}\n${newContent}`;
  }
}

function clampContent(content: string): string {
  if (content.length <= MEMORY_MERGED_CONTENT_MAX_LENGTH) {
    return content;
  }
  return content.slice(0, MEMORY_MERGED_CONTENT_MAX_LENGTH);
}
