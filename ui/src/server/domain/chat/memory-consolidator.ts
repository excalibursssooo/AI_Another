import type { AppDatabase } from "@/server/db/client";
import {
  embedText as defaultEmbedText,
  cosineSimilarity,
  hashEmbeddingText,
} from "@/server/ai/embeddings";
import type { EmbeddingResult } from "@/server/ai/embeddings";
import type { MemoryCandidate } from "@/server/ai/schemas";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";
import type { MemoryRecord } from "@/server/domain/memory/memory-repository";
import { MemoryOperationLogRepository } from "./memory-operation-log-repository";

export const MEMORY_MERGE_SIMILARITY = 0.86;
export const MEMORY_CONFLICT_SIMILARITY = 0.72;
export const MEMORY_MERGED_CONTENT_MAX_LENGTH = 500;
export const MEMORY_CONFLICT_TOP_K = 10;
export const MEMORY_FALLBACK_TEXT_SIMILARITY = 0.78;

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

export type EmbedText = typeof defaultEmbedText;

interface RankedMemory {
  memory: MemoryRecord;
  similarity: number;
}

export const CONFLICT_CAPABLE_TYPES = new Set([
  "preference", "boundary", "goal",
]);

const POSITIVE_PHRASES = [
  "喜欢", "爱", "想", "要", "希望", "倾向", "接受", "可以", "愿意", "允许", "计划", "准备",
];
const NEGATIVE_PHRASES = [
  "不喜欢", "不爱", "不想", "不要", "不希望", "讨厌", "排斥", "不接受", "拒绝", "不能", "禁止", "不再",
];
const DOUBLE_NEGATIVE_PHRASES = [
  "不是不喜欢", "并不是不喜欢", "不是不爱", "并不是不爱", "不是不想", "并不是不想",
];
const HYPOTHETICAL_TRIGGERS = [
  "如果", "要是", "假如", "假设", "要是能", "要是我",
  "的话", "情况下", "若", "若要",
];
const TEMPORAL_TRIGGERS = [
  "今天", "这次", "这次只", "临时", "最近", "目前",
  "今天下午", "今天晚上", "这周", "本周",
];
const LONG_TERM_MARKERS = [
  "以后", "从此", "从今以后", "从现在起", "默认", "永远",
  "不要再", "不要了", "不再", "一直",
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

function polarityOf(content: string): "positive" | "negative" | null {
  if (DOUBLE_NEGATIVE_PHRASES.some((p) => content.includes(p))) return null;
  for (const p of NEGATIVE_PHRASES) if (content.includes(p)) return "negative";
  for (const p of POSITIVE_PHRASES) if (content.includes(p)) return "positive";
  return null;
}

export type ConflictReason =
  | "type_not_conflict_capable"
  | "hypothetical_context"
  | "double_negative"
  | "temporal_vs_long_term"
  | "high_confidence_reversal"
  | "polarity_unchanged_or_ambiguous";

export interface ConflictDecision {
  conflict: boolean;
  reason: ConflictReason;
}

export function detectConflict(oldContent: string, newContent: string, memoryType: string): ConflictDecision {
  if (!CONFLICT_CAPABLE_TYPES.has(memoryType)) {
    return { conflict: false, reason: "type_not_conflict_capable" };
  }
  const hasLongTermMarker = containsAny(newContent, LONG_TERM_MARKERS);
  if (!hasLongTermMarker && containsAny(newContent, HYPOTHETICAL_TRIGGERS)) {
    return { conflict: false, reason: "hypothetical_context" };
  }
  if (containsAny(oldContent, DOUBLE_NEGATIVE_PHRASES) || containsAny(newContent, DOUBLE_NEGATIVE_PHRASES)) {
    return { conflict: false, reason: "double_negative" };
  }
  const isLongTermType = memoryType === "preference" || memoryType === "boundary";
  const oldTemporal = containsAny(oldContent, TEMPORAL_TRIGGERS);
  const newTemporal = containsAny(newContent, TEMPORAL_TRIGGERS);
  if (isLongTermType && (oldTemporal || newTemporal) && !hasLongTermMarker) {
    return { conflict: false, reason: "temporal_vs_long_term" };
  }
  const oldPolarity = polarityOf(oldContent);
  const newPolarity = polarityOf(newContent);
  if (oldPolarity !== null && newPolarity !== null && oldPolarity !== newPolarity) {
    return { conflict: true, reason: "high_confidence_reversal" };
  }
  return { conflict: false, reason: "polarity_unchanged_or_ambiguous" };
}

export class MemoryConsolidator {
  private readonly memories: MemoryRepository;
  private readonly embedText: EmbedText;
  private readonly db: AppDatabase;

  constructor(options: { db: AppDatabase; embedText?: EmbedText }) {
    this.memories = new MemoryRepository(options.db);
    this.embedText = options.embedText ?? defaultEmbedText;
    this.db = options.db;
  }

  async consolidate(input: ConsolidateMemoryInput): Promise<ConsolidationResult> {
    const content = input.candidate.content.trim();
    if (!content) {
      return { action: "skipped", reason: "empty content" };
    }

    const embedding = await this.embedText(content);
    if (embedding.fallbackReason !== undefined) {
      new MemoryOperationLogRepository(this.db).record({
        userId: input.userId, agentId: input.agentId, worldId: input.worldId,
        kind: "embedding_fallback",
        reason: embedding.fallbackReason,
        sourceTaskId: input.sourceTaskId ?? null,
      });
    }
    const embeddingInput = toEmbeddingInput(content, embedding);
    const comparable = this.memories
      .listActiveForScope(input)
      .filter((memory) => isComparable(memory, input.candidate));

    const ranked = rankComparable(comparable, embedding);

    const conflictChecks = ranked
      .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
      .slice(0, MEMORY_CONFLICT_TOP_K)
      .map((item) => ({
        item,
        decision: detectConflict(item.memory.content, content, input.candidate.type),
      }));

    const logs = new MemoryOperationLogRepository(this.db);

    const noConflictReasons: Record<string, number> = {};
    for (const { decision } of conflictChecks) {
      if (!decision.conflict) {
        noConflictReasons[decision.reason] = (noConflictReasons[decision.reason] ?? 0) + 1;
      }
    }
    if (conflictChecks.length > 0) {
      logs.record({
        userId: input.userId, agentId: input.agentId, worldId: input.worldId,
        kind: "no_conflict",
        reason: "summary",
        detail: { checked: conflictChecks.length, reasons: noConflictReasons },
        sourceTaskId: input.sourceTaskId ?? null,
      });
    }

    const conflict = conflictChecks.find(({ decision }) => decision.conflict);
    if (conflict) {
      logs.record({
        userId: input.userId, agentId: input.agentId, worldId: input.worldId,
        kind: "conflict",
        reason: conflict.decision.reason,
        detail: { similarity: conflict.item.similarity, frozenMemoryId: conflict.item.memory.id },
        sourceTaskId: input.sourceTaskId ?? null,
      });
      const created = this.memories.replaceConflicted({
        oldMemoryId: conflict.item.memory.id,
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
        frozenMemoryId: conflict.item.memory.id,
        reason: `conflict:${conflict.decision.reason}`,
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

    const fallbackMatch = findFallbackKeyMatch(comparable, input.candidate);
    if (fallbackMatch && embedding.quality !== "semantic") {
      return await this.mergeFallbackMemory(fallbackMatch, input.candidate, "same canonical key fallback memory");
    }

    const fallbackTextMatch = findFallbackTextMatch(comparable, input.candidate);
    if (fallbackTextMatch && embedding.quality !== "semantic") {
      return await this.mergeFallbackMemory(fallbackTextMatch, input.candidate, "similar text fallback memory");
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
    return detectConflict(oldContent, newContent, memoryType).conflict;
  }

  private async mergeFallbackMemory(
    memory: MemoryRecord,
    candidate: MemoryCandidate,
    reason: string,
  ): Promise<ConsolidationResult> {
    const mergedContent = mergeMemoryContent(memory, candidate);
    const mergedEmbedding = await this.embedText(mergedContent);
    const updated = this.memories.mergeMemory({
      memoryId: memory.id,
      content: mergedContent,
      importance: Math.max(memory.importance, candidate.importance),
      confidence: Math.max(memory.confidence, candidate.confidence),
      key: candidate.key ?? memory.key,
      topic: candidate.topic ?? memory.topic,
      embedding: toEmbeddingInput(mergedContent, mergedEmbedding),
      lastObservedAt: Date.now(),
    });
    return { action: "merged", memoryId: updated?.id, reason };
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

function findFallbackKeyMatch(memories: MemoryRecord[], candidate: MemoryCandidate): MemoryRecord | null {
  const key = candidate.key?.trim();
  if (!key) {
    return null;
  }
  return memories.find((memory) => memory.key === key) ?? null;
}

function findFallbackTextMatch(memories: MemoryRecord[], candidate: MemoryCandidate): MemoryRecord | null {
  const candidateContent = candidate.content.trim();
  if (candidateContent.length < 6) {
    return null;
  }
  let best: { memory: MemoryRecord; score: number } | null = null;
  for (const memory of memories) {
    if (detectConflict(memory.content, candidateContent, candidate.type).conflict) {
      continue;
    }
    const score = textSimilarity(memory.content, candidateContent);
    if (score < MEMORY_FALLBACK_TEXT_SIMILARITY) {
      continue;
    }
    if (!best || score > best.score) {
      best = { memory, score };
    }
  }
  return best?.memory ?? null;
}

function textSimilarity(left: string, right: string): number {
  const a = normalizeTextForSimilarity(left);
  const b = normalizeTextForSimilarity(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  return diceCoefficient(toBigrams(a), toBigrams(b));
}

function normalizeTextForSimilarity(content: string): string {
  return content
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:："'“”‘’`~\s]/g, "")
    .trim();
}

function toBigrams(content: string): string[] {
  if (content.length <= 1) {
    return content ? [content] : [];
  }
  const grams: string[] = [];
  for (let index = 0; index < content.length - 1; index += 1) {
    grams.push(content.slice(index, index + 2));
  }
  return grams;
}

function diceCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const gram of left) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
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
