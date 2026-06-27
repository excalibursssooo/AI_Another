# Memory Quality v1.1-r2 Design

**Supersedes:** `2026-06-27-memory-quality-v1.1-design.md` (r1). r1 had five design-vs-code mismatches; r2 fixes all of them. See "Changes from r1" at the bottom for the diff.

## Precondition

v1.1 assumes the current embedding consolidator (`memory-consolidator.ts`) and SQLite schema are the source of truth. It does **not** attempt to complete v1.0 deferred items such as lazy re-embedding of `stale`/`fallback`/`missing` memories or whole-scope transactional consolidation, unless explicitly listed in this spec.

Concretely:

- `MemoryConsolidator.rankComparable()` skips memories whose embedding is not `semantic` (fallback, malformed, dimension mismatch). v1.1 keeps this skip; it does not introduce a lazy refresh step.
- Conflict detection thresholds (`MEMORY_CONFLICT_SIMILARITY = 0.72`, `MEMORY_MERGE_SIMILARITY = 0.86`, `MEMORY_CONFLICT_TOP_K = 10`) stay unchanged.
- The `memories` table schema is unchanged.

## Goal

Extend yesterday's `2026-06-27-memory-consolidator-embedding-design.md` with four targeted improvements that target the largest remaining quality gaps in the memory pipeline **without reopening the deliberate design decisions** in that document:

1. Reduce unnecessary LLM cost by short-circuiting memory extraction **before** the model is called.
2. Reduce false-positive memory freezes from the deterministic conflict detector.
3. Make embedding fallback, conflict skips, and topic fallback **observable** instead of silent.
4. Improve feed `extractTopic` quality on the **fallback path** (when the feed LLM fails) from "first 4 words" to embedding-clustered topic keys.

This is **v1.1**, not v2. No new external dependencies. No changes to existing table schemas. No changes to `ChatReply` shape or `memory_extract` task public payload (new optional fields are added; existing fields stay).

## Scope

In scope:

- A new `ThrottleMemoryExtraction` flow node that sets `ctx.throttled = true` and short-circuits downstream nodes.
- A new `src/server/domain/chat/throttle-rules.ts` module with a pure-function rule set.
- New `MemoryExtractContext.throttled?: boolean` and `MemoryExtractContext.throttleReason?: ThrottleReason` fields. `ExtractMemoryCandidates` short-circuits if `ctx.throttled === true` so the memory LLM is never called.
- `detectConflict` returns `{ conflict, reason }` instead of `boolean`. The existing `detectConflictForTest` boolean wrapper stays so old tests do not break. v1.1 **replaces** the current preference-only implementation; this is not an additive change.
- A new `memory_operation_logs` SQLite table and `MemoryOperationLogRepository`. `record()` never throws. Log writes are aggregated (see "Logging volume control" below).
- A new `feed_topics` SQLite table scoped by `(user_id, world_id)` and a `FeedTopicRepository` that backs an embedding-clustered `extractTopicWithCluster` in `feed-flow.ts`. v1.1 only invokes this on the fallback path, not on the LLM-success path.
- `EmbeddingResult` gains a `fallbackReason?: EmbeddingFallbackReason` field so callers can log the exact reason `embedText` fell back.
- `chat-flow.ts` `EnqueueMemoryExtraction` payload gains an optional `fallbackReplies: string[]` field. `task-worker.ts` `parseMemoryExtractPayload` parses it when present and passes it to `createMemoryExtractFlow`.
- New `CREATE TABLE IF NOT EXISTS` blocks added to `db/client.ts` `initializeDatabase()` (no migration runner; matches current `migrateMemoryEmbeddingColumns()` pattern).
- Tests for every new code path, plus integration coverage on `MemoryExtractFlow`.

Out of scope:

- Using embeddings for memory recall (rejected by yesterday's spec — `memories_fts` + lexical scoring only).
- Touching `drainChatTasks` invocation (`api/chat/route.ts` already calls it correctly).
- Changing the merge / conflict thresholds.
- Changing `extractTopic` for the LLM-success path (i.e. no post-processing of `generated.topicSeed`).
- Replacing `extractTopic` with an LLM call.
- Async batched logging, log TTL cleanup, Prometheus exporter, `/admin/logs` endpoint.
- A SQL migration runner / `schema_migrations` table. v1.1 stays consistent with the current "init-and-alter" pattern.
- Source-level fallback tracking (i.e. matching which `generateChatReply` branch produced a reply). v1.1 only matches known static fallback text.
- Payload-level expansion for `MemoryExtractFlow` beyond `fallbackReplies` (no `recentMessages`).

## Architecture

```
chat-flow  ─► tasks.enqueue(memory_extract, payload: { ..., fallbackReplies?: string[] })
                  │
                  ▼
            MemoryExtractFlow
            ├── LoadMessagePair
            ├── ThrottleMemoryExtraction   ◄── NEW (#3)
            │     │
            │     ├─ rule hit → ctx.throttled = true, ctx.throttleReason = reason
            │     │                MemoryOperationLogRepository.record(kind='throttled')
            │     │
            │     └─ pass through
            │
            ├── ExtractMemoryCandidates
            │     ├─ IF ctx.throttled → return early with candidates = []    ◄── explicit short-circuit
            │     └─ ELSE generateMemoryExtraction (memory LLM)
            │
            └── ConsolidateMemories
                  ├── embedText
                  │     └─ embedding.fallbackReason !== undefined   ─► caller records
                  │                                                  (kind='embedding_fallback', reason=fallbackReason)  (#6)
                  │
                  ├── detectConflict v1.1   ◄── CHANGED (#4)
                  │     ├─ conflict → freeze old + create new
                  │     │                + record(kind='conflict')
                  │     │
                  │     └─ no conflict → AGGREGATE log:
                  │                       kind='no_conflict', reason='summary',
                  │                       detail={ checked, reasons: { ... } }     ◄── r2 noise fix
                  │
                  └── create / merge / skip

feed-flow  ─► GenerateFeedPost
            ├─ LLM success  → use generated.topicSeed unchanged                 (out of scope for v1.1)
            └─ LLM null/fail → extractTopicWithCluster                          ◄── CHANGED (#5)
                                ├── embedText(content)
                                │     └─ fallback → extractTopicFallback + record(kind='topic_fallback', reason='embedding_unavailable')
                                │
                                ├── FeedTopicRepository.match(user_id, world_id, cosine ≥ 0.75, last_used ≤ 90d)
                                │     ├─ hit  → use_count += 1, last_used_at = now
                                │     └─ miss → new topic_key from extractTopicFallback
                                │              + record(kind='topic_fallback', reason='cold_start' | 'no_match')
                                │
                                └── return topic_key
```

Boundary rules:

- **#3 throttle is task-worker level LLM throttling, not enqueue-level throttling.** `tasks.enqueue('memory_extract')` still runs; only the heavy LLM call inside is short-circuited.
- **`embedText()` is still fire-and-forget** — it does not throw on fallback. But it now **tags** the returned `EmbeddingResult` with `fallbackReason` so callers know **why** it fell back.
- **`MemoryOperationLogRepository.record()` never throws.** A logging failure cannot affect chat/feed paths. `try { ... } catch { console.error(...) }` inside the repository.
- **No new external dependencies.** No new environment variables.
- **Log writes are aggregated**, not per-item. See "Logging volume control" below.

## #3 — ThrottleMemoryExtraction (r2 fix)

### Node placement

A new node inserted between `LoadMessagePair` and `ExtractMemoryCandidates` in `createMemoryExtractFlow`:

```
LoadMessagePair
ThrottleMemoryExtraction   ◄── NEW
ExtractMemoryCandidates
ConsolidateMemories
```

### How short-circuit works (r1 was wrong)

The r1 spec said "set `ctx.candidates = []`". This **does not work** because `ExtractMemoryCandidates` (memory-extract-flow.ts:42-55) ignores prior `ctx.candidates` and always calls `generateExtraction(...)` when both messages are non-empty, then overwrites with `extraction?.memories ?? []`.

r2 fixes this with explicit short-circuit:

```ts
// MemoryExtractContext (extend, do not break)
export interface MemoryExtractContext {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  candidates?: MemoryCandidate[];
  persistedMemoryCount?: number;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  // ── v1.1 new ──────────────────────────────────────────
  throttled?: boolean;
  throttleReason?: ThrottleReason;
}
```

```ts
// ThrottleMemoryExtraction node
{
  name: "ThrottleMemoryExtraction",
  run: async (ctx) => {
    const decision = shouldThrottle({
      userMessage: ctx.userMessage,
      assistantMessage: ctx.assistantMessage,
      fallbackReplies: ctx.fallbackReplies ?? [],
    });
    if (decision.throttled) {
      new MemoryOperationLogRepository(options.db).record({
        userId: ctx.userId, agentId: ctx.agentId, worldId: ctx.worldId,
        kind: "throttled",
        reason: decision.reason!,
        sourceTaskId: ctx.sourceTaskId ?? null,
      });
      return {
        ...ctx,
        throttled: true,
        throttleReason: decision.reason,
        candidates: [],
      };
    }
    return ctx;
  },
}

// ExtractMemoryCandidates — first-line short-circuit
{
  name: "ExtractMemoryCandidates",
  run: async (ctx) => {
    if (ctx.throttled) {
      return { ...ctx, candidates: [] };   // never calls generateExtraction
    }
    if (!ctx.userMessage || !ctx.assistantMessage) {
      return { ...ctx, candidates: [] };
    }
    const extraction = await generateExtraction({ ... });
    return { ...ctx, candidates: extraction?.memories ?? [] };
  },
}
```

### Rules

`src/server/domain/chat/throttle-rules.ts` exposes:

```ts
export type ThrottleReason =
  | "fallback_reply"
  | "punctuation_only"
  | "repeated_punctuation"
  | "repeated_chars"
  | "confirmation_only"
  | "too_short"
  | "low_signal_non_cjk";

export interface ThrottleDecision {
  throttled: boolean;
  reason?: ThrottleReason;
}

export function shouldThrottle(input: {
  userMessage: string;
  assistantMessage: string;
  fallbackReplies?: string[];
}): ThrottleDecision
```

Evaluation order (first match wins):

1. **`fallback_reply`** — `assistantMessage` (trimmed, case-sensitive) is in the injected `fallbackReplies` list.
2. **`punctuation_only`** — after stripping CJK + Latin letters + digits, ≥ 70% of remaining chars are punctuation OR whitespace, in either message.
3. **`repeated_punctuation`** — any single punctuation char (`。！？!?，,；;…`) appears ≥ 3 times in a row in either message.
4. **`repeated_chars`** — any single non-punctuation char appears ≥ 5 times in a row in either message.
5. **`confirmation_only`** — `userMessage.trim()` exactly equals one of `["嗯", "哦", "好", "是的", "对", "可以", "行", "没错", "继续"]`.
6. **`too_short`** — either message, after trim, is < 6 chars AND neither message contains any `STRONG_MEMORY_TRIGGER`.
7. **`low_signal_non_cjk`** — combined CJK char count in both messages < 5 AND combined length ≥ 6 chars AND neither message contains any `EN_MEMORY_TRIGGER`.

### Whitelists

```ts
const STRONG_MEMORY_TRIGGERS = [
  "记住", "以后", "默认", "不要再", "别叫", "我喜欢", "我不喜欢",
  "我讨厌", "我希望", "你以后", "你不要", "设定", "世界观", "我叫",
];

const EN_MEMORY_TRIGGERS = [
  "remember", "call me", "don't", "do not", "i like", "i dislike",
  "i hate", "prefer", "always", "never", "default", "setting", "world", "lore",
];
```

### `containsAny` matching semantics

All whitelist lookups in this spec use the same `containsAny(haystack, needles)` helper:

```ts
function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.toLowerCase().includes(needle.toLowerCase())) return true;
  }
  return false;
}
```

- CJK phrases: case-insensitive substring match (case is irrelevant for CJK but kept consistent).
- English phrases: case-insensitive substring match (the trigger list is chosen to be unambiguous; `"don't"` matches `"Don't call me"`).
- No word-boundary awareness. Whitelist phrases are short and distinctive enough that substring matching is safe.

### `fallbackReplies` injection (r2 fix)

`chat-flow.ts` `EnqueueMemoryExtraction` adds `fallbackReplies` to the task payload. The list is constructed **once at enqueue time**:

```ts
tasks.enqueue({
  kind: "memory_extract",
  payload: {
    userId: ctx.userId,
    agentId: ctx.agentId,
    worldId: ctx.worldId,
    conversationId: ctx.conversationId ?? null,
    userMessage: ctx.input,
    assistantMessage: ctx.reply ?? "",
    fallbackReplies: collectFallbackReplies(),  // see below
  },
});
```

```ts
function collectFallbackReplies(): string[] {
  // v1.1 only matches known static fallback text. We do NOT track which
  // generateChatReply branch produced the reply — that would require
  // restructuring ChatReply, which is out of scope.
  return [
    "我在这里。你刚才说的我记住了。",                    // mockProvider fallback
    "当前模型暂时不可用，但我已经收到你的消息了。",     // generateChatReply fallbackReply()
    // Additional templates can be added here. Each must be the EXACT reply text.
  ];
}
```

High-risk safety replies (`assessRisk === "high"`) are **not** included because `SafetyCheck` blocks them before `EnqueueMemoryExtraction`.

`task-worker.ts` `parseMemoryExtractPayload` is extended to parse the optional field:

```ts
function parseMemoryExtractPayload(payload: unknown): {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  fallbackReplies?: string[];
} {
  // ... existing parsing unchanged ...
  const fallbackReplies = Array.isArray(record.fallbackReplies)
    ? record.fallbackReplies.filter((x): x is string => typeof x === "string")
    : undefined;
  return { userId, agentId, worldId, userMessage, assistantMessage, agentName, fallbackReplies };
}
```

`createMemoryExtractFlow` propagates `fallbackReplies` into `MemoryExtractContext`.

### Expected impact

- High-frequency casual users: 50–70% of turns short-circuited.
- Average users: 20–40% short-circuited.
- Long focused sessions: < 10% short-circuited.
- LLM cost for memory extraction should drop by at least 30% in mixed traffic.

## #4 — detectConflict v1.1 (r2 fix)

r1 said constants were "unchanged". That was wrong: the current `detectConflict` (`memory-consolidator.ts:275`) only handles `memoryType === "preference"` with a small positive/negative phrase set. v1.1 **replaces** that implementation; it is not additive.

### Signature change (backward compatible)

```ts
// Before (current)
function detectConflict(oldContent: string, newContent: string, memoryType: string): boolean;

// After (v1.1)
export type ConflictReason =
  | "type_not_conflict_capable"
  | "long_term_marker_present"     // skip hypothetical guard
  | "hypothetical_context"
  | "double_negative"
  | "temporal_vs_long_term"
  | "high_confidence_reversal"
  | "polarity_unchanged_or_ambiguous";

export interface ConflictDecision {
  conflict: boolean;
  reason: ConflictReason;
}

function detectConflict(oldContent: string, newContent: string, memoryType: string): ConflictDecision;
```

`detectConflictForTest(old, new, type): boolean` continues to exist as `return detectConflict(old, new, type).conflict;`. All existing tests continue to pass without modification.

### Decision flow (r2 fix: long-term markers checked BEFORE hypothetical)

```ts
function detectConflict(old, new, type): ConflictDecision {
  if (!CONFLICT_CAPABLE_TYPES.has(type)) {
    return { conflict: false, reason: "type_not_conflict_capable" };
  }

  // r2: long-term markers bypass the hypothetical guard. This is critical
  // because phrases like "我希望以后不要..." legitimately express a long-term
  // boundary change and must not be classified as hypothetical.
  const hasLongTermMarker = containsAny(new, LONG_TERM_MARKERS);
  if (!hasLongTermMarker && containsAny(new, HYPOTHETICAL_TRIGGERS)) {
    return { conflict: false, reason: "hypothetical_context" };
  }

  if (containsAny(old, DOUBLE_NEGATIVE_PHRASES) || containsAny(new, DOUBLE_NEGATIVE_PHRASES)) {
    return { conflict: false, reason: "double_negative" };
  }

  const isLongTermType = type === "preference" || type === "boundary";
  const oldTemporal = containsAny(old, TEMPORAL_TRIGGERS);
  const newTemporal = containsAny(new, TEMPORAL_TRIGGERS);
  if (isLongTermType && (oldTemporal || newTemporal) && !hasLongTermMarker) {
    return { conflict: false, reason: "temporal_vs_long_term" };
  }

  const oldPolarity = polarityOf(old);
  const newPolarity = polarityOf(new);
  if (oldPolarity !== null && newPolarity !== null && oldPolarity !== newPolarity) {
    return { conflict: true, reason: "high_confidence_reversal" };
  }

  return { conflict: false, reason: "polarity_unchanged_or_ambiguous" };
}
```

`CONFLICT_CAPABLE_TYPES`, `POSITIVE_PHRASES`, `NEGATIVE_PHRASES`, `DOUBLE_NEGATIVE_PHRASES`, and `polarityOf` are introduced in v1.1. The current `detectConflict` is removed entirely.

### New phrase tables

```ts
const CONFLICT_CAPABLE_TYPES = new Set([
  "profile", "preference", "relationship", "goal", "boundary",
]);

const POSITIVE_PHRASES = [
  "喜欢", "爱", "想", "要", "希望", "倾向", "接受", "可以", "愿意", "允许", "计划", "准备",
];
const NEGATIVE_PHRASES = [
  "不喜欢", "不爱", "不想", "不要", "不希望", "讨厌", "排斥", "不接受", "拒绝", "不能", "禁止",
];
const DOUBLE_NEGATIVE_PHRASES = [
  "不是不喜欢", "并不是不喜欢", "不是不爱", "并不是不爱", "不是不想", "并不是不想",
];

// r2: "我希望" / "我想要" are REMOVED from hypothetical triggers. They are
// ambiguous between "I wish" (hypothetical) and "I want" (long-term boundary).
// Use real hypothetical markers instead.
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
```

### Consolidation integration with aggregated logging (r2 fix)

```ts
const conflictChecks = ranked
  .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
  .slice(0, MEMORY_CONFLICT_TOP_K)
  .map((item) => ({
    item,
    decision: detectConflict(item.memory.content, content, input.candidate.type),
  }));

const logs = new MemoryOperationLogRepository(options.db);

// r2: aggregate no_conflict logs to avoid 8 × 10 = 80 rows per task.
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
    detail: {
      checked: conflictChecks.length,
      reasons: noConflictReasons,
    },
    sourceTaskId: input.sourceTaskId ?? null,
  });
}

const conflict = conflictChecks.find(({ decision }) => decision.conflict);
if (conflict) {
  logs.record({
    userId: input.userId, agentId: input.agentId, worldId: input.worldId,
    kind: "conflict",
    reason: conflict.decision.reason,
    detail: {
      similarity: conflict.item.similarity,
      frozenMemoryId: conflict.item.memory.id,
    },
    sourceTaskId: input.sourceTaskId ?? null,
  });
  // freeze / supersede flow unchanged
}
```

`ConsolidationResult.reason` becomes a composite string: `conflict:high_confidence_reversal` / `merged:similar_semantic_memory` / `created:no_comparable_semantic_memory`.

### Tradeoffs accepted

- **No LLM judge in v1.1.** The user explicitly chose to lower false positives rather than maximize recall of all reversals.
- **Thresholds untouched.** `MEMORY_CONFLICT_SIMILARITY = 0.72` and `MEMORY_MERGE_SIMILARITY = 0.86` stay.
- **`"我希望"` ambiguity resolved by long-term marker check.** Phrases like `"我希望以后不要晚间提醒"` now correctly trigger `high_confidence_reversal` instead of `hypothetical_context`.
- **Phrasing false negatives.** A user saying `"我重新想了一下，觉得我不喜欢这个"` still triggers hypothetical (`想了一下` doesn't match our hypothetical markers; OK), but `"假如我不再喜欢"` without a long-term marker will be classified as hypothetical — accepted limitation.

## #5 — extractTopic v1.1 (r2 fix: scope clarified)

### Scope of this change (r2 fix)

`feed-flow.ts:142` is the **only** call site of `extractTopic` today:

```ts
if (generated) {
  return { ...ctx, topicSeed: generated.topicSeed, ... };  // path A: LLM succeeded
}
// path B: LLM returned null → fallback
const topicSeed = extractTopic(lastUserMessage || agent.persona);
```

v1.1 only changes path B. Path A (`generated.topicSeed`) is **untouched**. This spec does not introduce a post-processor that re-clusters LLM-generated topic seeds — that would expand scope beyond v1.1.

The user-visible improvement is: when the feed LLM is unavailable (mock provider, model offline, structured-output failure), the fallback topic quality goes from "first 4 words of recent user message" to a clustered topic key with stable identity across fallback episodes.

### New table (r2 fix: scoped, not per-deployment)

```sql
CREATE TABLE feed_topics (
  id TEXT PRIMARY KEY,                          -- topic-{uuid}
  user_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  agent_id TEXT,                                -- optional, NULL = shared within world
  topic_key TEXT NOT NULL,
  representative_embedding_json TEXT NOT NULL,   -- NO raw text stored; embedding only
  embedding_model TEXT NOT NULL,
  embedding_quality TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  UNIQUE (user_id, world_id, agent_id, topic_key)
);
CREATE INDEX idx_feed_topics_scope_last_used
  ON feed_topics(user_id, world_id, agent_id, last_used_at DESC);
```

**Why scoping (r2 fix):**

- The current data model scopes `feed_posts` by `user_id / agent_id / world_id`. Sharing topic clusters across users would mix private vocabulary.
- Storing only the embedding (not raw `representative_text`) avoids retaining user message content for clustering purposes. The topic_key is short and derived, not the message itself.
- `agent_id` is optional (nullable) so the same user can have shared topics across agents in the same world (e.g. "咖啡") and agent-specific topics (e.g. agent-A's "私房书单").

### Constants

```ts
export const TOPIC_MATCH_SIMILARITY = 0.75;
export const TOPIC_RECENT_WINDOW_DAYS = 90;
export const TOPIC_KEY_MAX_CJK = 8;
export const TOPIC_KEY_MAX_WORDS = 4;
```

### `extractTopicWithCluster`

```ts
export async function extractTopicWithCluster(input: {
  content: string;
  userId: string;
  agentId: string;
  worldId: string;
  sourceTaskId?: string | null;
}): Promise<string> {
  const topics = new FeedTopicRepository(db);
  const logs = new MemoryOperationLogRepository(db);
  const embedding = await embedText(input.content);

  if (embedding.fallbackReason !== undefined || embedding.quality !== "semantic") {
    logs.record({
      kind: "topic_fallback", reason: "embedding_unavailable",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: input.agentId, worldId: input.worldId,
    });
    return extractTopicFallback(input.content);
  }

  const recent = topics.listRecent({
    userId: input.userId, worldId: input.worldId, agentId: input.agentId,
    sinceDays: TOPIC_RECENT_WINDOW_DAYS,
  });

  if (recent.length === 0) {
    const key = topics.create({
      userId: input.userId, worldId: input.worldId, agentId: input.agentId,
      topicKey: extractTopicFallback(input.content),
      embedding,
    });
    logs.record({
      kind: "topic_fallback", reason: "cold_start",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: input.agentId, worldId: input.worldId,
    });
    return key;
  }

  const matched = topics.bestMatchByCosine(recent, embedding, TOPIC_MATCH_SIMILARITY);
  if (matched) {
    topics.touch(matched.id);
    return matched.topicKey;
  }

  const key = topics.create({
    userId: input.userId, worldId: input.worldId, agentId: input.agentId,
    topicKey: extractTopicFallback(input.content),
    embedding,
  });
  logs.record({
    kind: "topic_fallback", reason: "no_match",
    sourceTaskId: input.sourceTaskId ?? null,
    userId: input.userId, agentId: input.agentId, worldId: input.worldId,
  });
  return key;
}
```

### `FeedTopicRepository` API contract

```ts
export interface FeedTopicRecord {
  id: string;
  userId: string;
  worldId: string;
  agentId: string | null;
  topicKey: string;
  representativeEmbeddingJson: string;
  embeddingModel: string;
  embeddingQuality: string;
  embeddingDimension: number;
  useCount: number;
  firstSeenAt: number;
  lastUsedAt: number;
}

export interface CreateFeedTopicInput {
  userId: string;
  worldId: string;
  agentId: string | null;
  topicKey: string;
  embedding: EmbeddingResult;
}

export interface ListRecentInput {
  userId: string;
  worldId: string;
  agentId: string | null;
  sinceDays: number;
}

export interface TopicMatch {
  id: string;
  topicKey: string;
  similarity: number;
}

export class FeedTopicRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateFeedTopicInput): string                          // returns topicKey (idempotent on UNIQUE conflict)
  listRecent(input: ListRecentInput): FeedTopicRecord[]                // ORDER BY last_used_at DESC
  touch(id: string): void                                               // use_count += 1, last_used_at = now
  isEmpty(input: { userId, worldId, agentId }): boolean
  bestMatchByCosine(
    candidates: FeedTopicRecord[],
    queryEmbedding: EmbeddingResult,
    threshold: number,
  ): TopicMatch | null
}
```

`bestMatchByCosine` is a pure function over the repository's data. `extractTopicWithCluster` calls `embedText` once, then asks the repo to find the nearest neighbour above the threshold.

### `extractTopicFallback` (renamed from current `extractTopic`)

```ts
function extractTopicFallback(text: string): string {
  const normalized = text.replace(/[。！？!?，,]/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const candidate = words.length > 0 ? words.slice(0, 4).join(" ") : normalized.slice(0, 18);
  return clampTopicKey(candidate) || "日常";
}

function clampTopicKey(s: string): string {
  const cjkChars = [...s].filter((ch) => /[一-龥]/.test(ch));
  if (cjkChars.length > TOPIC_KEY_MAX_CJK) {
    return cjkChars.slice(0, TOPIC_KEY_MAX_CJK).join("");
  }
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > TOPIC_KEY_MAX_WORDS) return words.slice(0, TOPIC_KEY_MAX_WORDS).join(" ");
  return s;
}
```

The original `extractTopic` is renamed to `extractTopicFallback` and used only as the topic-key generator. `extractTopicWithCluster` is the new public entry point called from `feed-flow.ts:142`.

## #6 — memory_operation_logs (r2 fix: aggregation + filter)

### Schema

```sql
CREATE TABLE memory_operation_logs (
  id TEXT PRIMARY KEY,                      -- mem-op-{uuid}
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- see enum
  reason TEXT NOT NULL,                     -- short subreason
  detail TEXT,                              -- JSON, metadata only, no PII or message text
  source_task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mol_kind_time ON memory_operation_logs(kind, created_at DESC);
CREATE INDEX idx_mol_scope_time ON memory_operation_logs(user_id, agent_id, world_id, created_at DESC);
```

### `kind` enum (final)

| `kind` | Triggered by | `reason` values |
|---|---|---|
| `throttled` | #3 pre-filter rejection | one of `ThrottleReason` |
| `embedding_fallback` | caller observes `embedding.fallbackReason !== undefined` | `fetch_failed`, `non_2xx_status`, `invalid_response_shape`, `vector_dimension_zero`, `aborted` |
| `conflict` | #4 high-confidence reversal | `high_confidence_reversal` |
| `no_conflict` | #4 aggregated across topK checks (one row per candidate × topK round) | `summary` (with `detail.reasons`) |
| `topic_fallback` | #5 fallback path | `embedding_unavailable`, `cold_start`, `no_match` |

### Logging volume control (r2 fix)

Without aggregation, a typical memory task with 8 candidates and topK=10 would write `8 × 10 = 80` `no_conflict` rows plus 8 conflict/embedding logs — about 90 rows per chat turn. That's far too noisy.

**Rules:**

- `conflict`, `embedding_fallback`, `throttled`: always one row per event. These are the high-signal events.
- `no_conflict`: **aggregated to one row per consolidation round**. `detail.reasons` is a `{ reason: count }` map. Total rows per round ≤ candidates count, not candidates × topK.
- `topic_fallback`: one row per fallback invocation (cold start, no match, embedding unavailable).
- Console output is **filtered by default**:
  - `conflict`, `embedding_fallback`, `throttled` → always printed via `console.info` / `console.warn`.
  - `no_conflict` → only printed when `process.env.MEMORY_OP_VERBOSE_LOG === "true"`.
  - `topic_fallback` → only printed when `MEMORY_OP_VERBOSE_LOG === "true"`.

### Repository

`src/server/domain/chat/memory-operation-log-repository.ts`:

```ts
export type MemoryOpKind =
  | "throttled"
  | "embedding_fallback"
  | "conflict"
  | "no_conflict"
  | "topic_fallback";

export interface MemoryOperationLogRecord { /* see schema above */ }

export class MemoryOperationLogRepository {
  constructor(private readonly db: AppDatabase) {}

  record(input: {
    userId: string;
    agentId: string;
    worldId: string;
    kind: MemoryOpKind;
    reason: string;
    detail?: Record<string, unknown>;
    sourceTaskId?: string | null;
  }): void {
    try {
      // INSERT INTO memory_operation_logs ...
    } catch (error) {
      console.error("[memory-ops] failed to record log:", error);
      return;
    }

    const verboseOnly = input.kind === "no_conflict" || input.kind === "topic_fallback";
    const verboseEnabled = process.env.MEMORY_OP_VERBOSE_LOG === "true";
    if (!verboseOnly || verboseEnabled) {
      const level = input.kind === "embedding_fallback" ? "warn" : "info";
      console[level]("[memory-ops]", JSON.stringify({
        kind: input.kind,
        reason: input.reason,
        scope: `${input.userId}/${input.agentId}/${input.worldId}`,
        sourceTaskId: input.sourceTaskId ?? null,
        ts: Date.now(),
      }));
    }
  }

  listRecent(input: { kind?: MemoryOpKind; limit?: number }): MemoryOperationLogRecord[]
}
```

`record()` is **synchronous** and **never throws**.

## Database Model Changes (r2 fix: no migration runner)

r1 proposed separate SQL files under `ui/src/server/db/migrations/` and a runner. **The current codebase does not have a SQL migration runner.** The current pattern is:

```ts
// db/client.ts:initializeDatabase()
CREATE TABLE IF NOT EXISTS ...;
migrateMemoryEmbeddingColumns(db);  // ad-hoc ALTER TABLE functions
migrateAgentLiveStatesScope(db);
```

v1.1 stays consistent with this pattern. **No new migration runner. No `schema_migrations` table.**

The two new tables are added directly to `initializeDatabase()`:

```ts
// db/client.ts (extend initializeDatabase)

CREATE TABLE IF NOT EXISTS memory_operation_logs (...);
CREATE INDEX IF NOT EXISTS idx_mol_kind_time ON memory_operation_logs(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mol_scope_time ON memory_operation_logs(user_id, agent_id, world_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_topics (...);
CREATE INDEX IF NOT EXISTS idx_feed_topics_scope_last_used ON feed_topics(user_id, world_id, agent_id, last_used_at DESC);
```

Drizzle schema (`db/schema.ts`) mirrors both tables for typed access (mirroring the existing `tasks` / `memories` / etc. definitions).

### Why not a runner

The user explicitly chose to stay consistent with the current init-and-alter style. v1.1 is "small step upgrade"; introducing a runner would expand scope to v2 concerns (runner design, error recovery, partial-failure semantics).

### Rollback

Drop the two tables and the two indexes. Existing functionality is unaffected.

## EmbeddingResult extension (r2 fix)

Current `EmbeddingResult` in `embeddings.ts` has no fallback-reason field. v1.1 adds:

```ts
// embeddings.ts
export type EmbeddingFallbackReason =
  | "fetch_failed"
  | "non_2xx_status"
  | "invalid_response_shape"
  | "vector_dimension_zero"
  | "aborted";

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  backend: EmbeddingBackend;
  quality: EmbeddingQuality;
  model: string;
  version: number;
  needsRefresh: boolean;
  fallbackReason?: EmbeddingFallbackReason;  // NEW; only set when backend === "fallback"
}
```

`embedText` is rewritten to tag the fallback `EmbeddingResult` with `fallbackReason`:

```ts
} catch (error) {
  const fallbackReason = classifyEmbeddingError(error);
  return {
    vector: createFallbackEmbedding(normalized, readFallbackDimension()),
    dimension: readFallbackDimension(),
    backend: "fallback",
    quality: "lexical",
    model: "fallback-hash-v1",
    version: EMBEDDING_VERSION,
    needsRefresh: true,
    fallbackReason,
  };
}
```

```ts
export function classifyEmbeddingError(error: unknown): EmbeddingFallbackReason {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("embedding request failed")) return "non_2xx_status";
    if (msg.includes("embedding response missing data") || msg.includes("embedding response missing vector")) return "invalid_response_shape";
    if (msg.includes("aborted")) return "aborted";
    return "fetch_failed";
  }
  return "fetch_failed";
}
```

Callers (`MemoryConsolidator`, `extractTopicWithCluster`) check `embedding.fallbackReason` and call `MemoryOperationLogRepository.record({ kind: 'embedding_fallback', reason: embedding.fallbackReason })` when set.

## llama.cpp Backend (unchanged)

The llama.cpp embedding server setup from yesterday's spec stays unchanged. No new environment variables except the optional `MEMORY_OP_VERBOSE_LOG` for console filtering.

## Error Handling

| Scenario | Behavior |
|---|---|
| llama.cpp unavailable | `embedText` returns fallback tagged with `fallbackReason`; caller records `embedding_fallback` |
| Memory LLM throws / structured output fails | `generateMemoryExtraction` returns `null` (existing); no extra log beyond yesterday's design |
| `detectConflict` returns hypothetical reason | No freeze; aggregated `no_conflict` log recorded |
| `extractTopicWithCluster` embedding fails | `topic_fallback` log + fallback path |
| `record()` itself fails | Caught, `console.error` only. Business path continues |
| Migration / `initializeDatabase` fails on startup | Existing pattern: startup aborts (preserves yesterday's behavior) |
| `feed_topics` grows beyond 1000 rows | Not auto-pruned; admin queries the table manually. v2 cron job will prune. |

## Testing

### Unit tests

| File | Coverage |
|---|---|
| `throttle-rules.test.ts` (new) | All 7 reasons hit and miss; whitelists override `too_short` / `low_signal_non_cjk`; `fallbackReplies` injection works; `containsAny` case-insensitive |
| `memory-consolidator.test.ts` (rewritten) | New `ConflictDecision` returns for each reason; long-term marker bypasses hypothetical; double-negative still wins; temporal-vs-long-term only fires on preference/boundary; `detectConflictForTest` still returns boolean |
| `memory-operation-log-repository.test.ts` (new) | `record()` does not throw on DB error; `listRecent` orders correctly; console verbosity filter respects `MEMORY_OP_VERBOSE_LOG` |
| `feed-topic-repository.test.ts` (new) | `create` / `listRecent` / `touch` / `bestMatchByCosine`; UNIQUE conflict is idempotent |
| `feed-flow.test.ts` (extended) | `extractTopicWithCluster` cold-start / hit / miss paths; **scoped by (user_id, world_id, agent_id)** — different users do not share topics |
| `embeddings.test.ts` (rewritten) | `embedText` returns `fallbackReason` for each error class; `classifyEmbeddingError` returns the right reason |
| `task-worker.test.ts` (extended) | `parseMemoryExtractPayload` reads `fallbackReplies` when present; defaults to undefined when absent |

### Integration tests

| Scenario | Assertion |
|---|---|
| Throttled input | `generateMemoryExtraction` spy never called; `ctx.throttled === true`; one `throttled` row in `memory_operation_logs`; `candidates = []` propagates |
| Hypothetical conflict input (`"如果 X"`) | `detectConflict` returns `hypothetical_context`; old memory stays `active`; aggregated `no_conflict` row with `detail.reasons.hypothetical_context = 1` |
| Long-term marker input (`"我希望以后不要晚间提醒"`) | `detectConflict` returns `high_confidence_reversal`; old memory `frozen`; one `conflict` row |
| Embedding fallback during consolidation | `MemoryOperationLogRepository.record({ kind: 'embedding_fallback', reason: 'non_2xx_status', ... })` called once |
| `extractTopicWithCluster` cold-start (mock provider) | First call writes one `feed_topics` row scoped to `(user_id, world_id, agent_id)`, returns its key, logs `topic_fallback` with `reason: 'cold_start'` |
| `extractTopicWithCluster` hit | Cosine ≥ 0.75 against existing topic: `use_count += 1`, no new topic created, no log row |
| `extractTopicWithCluster` cross-user isolation | Two users with similar fallback content get distinct topic rows; embeddings do not cluster across users |
| 90-day window | Manually back-date `last_used_at`; new similar content creates a new topic, logs `no_match` |
| `extractTopic` LLM success path untouched | `generateFeedPostDraft` returning a draft does NOT call `extractTopicWithCluster` |

### Verification commands

```bash
cd ui
npm run test:run
npm run lint
npm run build
```

Optional local llama.cpp smoke:

```bash
cd ui
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1 npm run test:run -- \
  src/server/ai/embeddings.test.ts \
  src/server/domain/chat/feed-flow.test.ts
```

## Acceptance Criteria

1. **Throttling reduces LLM cost.**
   - Mock the memory LLM. Run 100 turns of mixed (long, short, confirmation-only) inputs. `generateMemoryExtraction` is called fewer than 70 times.
   - 10 confirmation-only turns → 0 memory LLM calls.
   - `ctx.throttled === true` is observable from `memory-extract-flow.test.ts`.

2. **Conflict false positives drop.**
   - All existing `memory-consolidator.test.ts` cases pass unchanged.
   - 10 hypothetical inputs (`"如果 X"`, `"要是 Y"`): 0 freezes, aggregated `no_conflict` row counts 10 hypothetical_context entries.
   - 5 temporary inputs on long-term preferences: 0 freezes, aggregated `no_conflict` row counts 5 temporal_vs_long_term entries.
   - **r2 specific**: `"我希望以后不要晚间提醒"` against `"接受晚间提醒"` triggers `conflict`, not `hypothetical_context`.

3. **Embedding fallback is observable.**
   - Disable the llama.cpp server. Run 5 consolidation rounds. `memory_operation_logs` has 5 `embedding_fallback` rows; each row's `reason` is one of the four `EmbeddingFallbackReason` values (not just `fetch_failed`); console shows matching `[memory-ops]` warn lines.

4. **Topic clustering on fallback path.**
   - Mock `generateFeedPostDraft` to return `null`. Run 3 fallback feed generations with similar content (`"今天喝了咖啡"`, `"刚泡了咖啡"`, `"咖啡真好喝"`). `feed_topics` ends with 1 row scoped to the current `(user_id, world_id, agent_id)`, `use_count = 3`.
   - Run 1 fallback feed generation with unrelated content (`"加班到深夜"`). `feed_topics` ends with 2 rows for the same scope.
   - Different user with similar content → distinct row.

5. **Backward compatibility.**
   - `detectConflictForTest()` boolean wrapper still exists; old test suite passes without edits.
   - `memories`, `feed_posts`, `tasks`, `conversations`, `agents`, `worlds`, `agent_live_states` table schemas unchanged.
   - Yesterday's spec Acceptance Criteria all still hold.

6. **Logging does not regress latency.**
   - Synthetic load (8 candidates × topK=10): total `memory_operation_logs` rows written per chat turn ≤ 20 (vs. ~90 in r1 design).
   - p95 chat-flow latency increases by < 1ms after `record()` calls are wired in.
   - Console output for `no_conflict` is suppressed unless `MEMORY_OP_VERBOSE_LOG=true`.

7. **No new external dependencies.**
   - `package.json` is unchanged.

8. **Topic clustering does not affect LLM-success path.**
   - `feed-flow.test.ts` asserts that when `generateFeedPostDraft` returns a draft, the resulting `topicSeed` equals `generated.topicSeed` byte-for-byte.

## File Change Manifest

```
NEW
  ui/src/server/domain/chat/throttle-rules.ts
  ui/src/server/domain/chat/throttle-rules.test.ts
  ui/src/server/domain/chat/memory-operation-log-repository.ts
  ui/src/server/domain/chat/memory-operation-log-repository.test.ts
  ui/src/server/domain/chat/feed-topic-repository.ts
  ui/src/server/domain/chat/feed-topic-repository.test.ts

MODIFY
  ui/src/server/flow/memory-extract-flow.ts
    - extend MemoryExtractContext with throttled? + throttleReason?
    - add ThrottleMemoryExtraction node
    - add first-line short-circuit in ExtractMemoryCandidates
    - accept fallbackReplies option, propagate to context
  ui/src/server/flow/memory-extract-flow.test.ts
    - new throttle + log integration
  ui/src/server/flow/chat-flow.ts
    - pass fallbackReplies in EnqueueMemoryExtraction payload
  ui/src/server/flow/task-worker.ts
    - parseMemoryExtractPayload reads fallbackReplies when present
  ui/src/server/flow/feed-flow.ts
    - extractTopicWithCluster replaces extractTopic call at fallback path
    - rename extractTopic → extractTopicFallback
  ui/src/server/flow/feed-flow.test.ts
    - new cluster + fallback tests
    - LLM-success path unchanged assertion
  ui/src/server/domain/chat/memory-consolidator.ts
    - detectConflict returns ConflictDecision
    - CONFLICT_CAPABLE_TYPES / phrase tables introduced (REPLACES preference-only)
    - consolidate() aggregates no_conflict logs
    - records embedding_fallback when embedding.fallbackReason set
  ui/src/server/domain/chat/memory-consolidator.test.ts
    - rewritten for new decision flow
  ui/src/server/db/client.ts
    - initializeDatabase adds memory_operation_logs + feed_topics CREATE TABLE IF NOT EXISTS
  ui/src/server/db/schema.ts
    - mirror memory_operation_logs + feed_topics
  ui/src/server/ai/embeddings.ts
    - EmbeddingResult.fallbackReason field
    - classifyEmbeddingError helper
    - embedText tags fallback result with fallbackReason
  ui/src/server/ai/embeddings.test.ts
    - rewritten for new error taxonomy

DOCS
  docs/superpowers/specs/2026-06-27-memory-quality-v1.1-design.md     # r1 (kept for history, marked superseded)
  docs/superpowers/specs/2026-06-27-memory-quality-v1.1-r2-design.md   # this file (canonical)
  docs/superpowers/plans/2026-06-27-memory-quality-v1.1-r2.md          # produced by writing-plans skill
```

## Migration Order

The implementation must follow this order so each step is independently verifiable:

1. **`EmbeddingResult.fallbackReason` + `classifyEmbeddingError`** in `embeddings.ts`. Run existing `embeddings.test.ts`; it should pass (new field is optional, default behavior unchanged for callers that don't check it).
2. **DB tables** in `db/client.ts` `initializeDatabase()`: `memory_operation_logs` and `feed_topics` (with `CREATE TABLE IF NOT EXISTS`). Drizzle schema mirror.
3. **`MemoryOperationLogRepository`** standalone. `record()` and `listRecent()`. Console filter respects `MEMORY_OP_VERBOSE_LOG`. No callers yet — covered by unit tests.
4. **`FeedTopicRepository`** standalone. `create` / `listRecent` / `touch` / `bestMatchByCosine` / `isEmpty`. Same pattern.
5. **`#4 detectConflict v1.1`**. Rewrite `detectConflict` and `MemoryConsolidator.consolidate()` to use the new flow with aggregated `no_conflict` logging. Run existing `memory-consolidator.test.ts` first; boolean wrapper means old assertions still hold. Then add new cases (long-term marker bypasses hypothetical, temporal_vs_long_term scoped to preference/boundary).
6. **`#3 throttle`**. Extend `MemoryExtractContext`. Add `ThrottleMemoryExtraction` node. Add first-line short-circuit in `ExtractMemoryCandidates`. Wire `record()` calls. Extend `chat-flow.ts` and `task-worker.ts` for `fallbackReplies`. Run integration tests.
7. **`#5 topic clustering`**. Add `extractTopicWithCluster`. Wire `record()` calls. Scope by `(user_id, world_id, agent_id)`. Run feed-flow tests, including LLM-success-path-untouched assertion.
8. After each step: `npm run test:run && npm run lint && npm run build`.

## Risks and Rollback

| Risk | Probability | Mitigation |
|---|---|---|
| New tables break startup | Low | `CREATE TABLE IF NOT EXISTS`; rollback is `DROP TABLE` of the two new tables |
| Throttle over-blocks | Medium | Strong-memory whitelist covers known important phrases; observe `throttled` log ratio for one week post-deploy; alert if > 80% |
| Long-term marker ambiguous (e.g. `"如果以后..."` has both `如果` and `以后`) | Low | Long-term marker check happens before hypothetical check; both present → long-term wins |
| `no_conflict` aggregation hides per-item false positives | Low | `detail.reasons` carries the count breakdown; console verbosity toggle for forensic inspection |
| `feed_topics` cross-user data leak | Low (none after scoping fix) | Scoped by `(user_id, world_id, agent_id)`; UNIQUE constraint prevents duplicates; integration test asserts isolation |
| `feed_topics` grows unboundedly | Medium | 90-day window limits match candidates; row count manually reviewed after one week; v2 cron prunes |
| Logging write latency | Low | Synchronous single-row INSERT, sub-millisecond; aggregated writes are one row per round, not per item |
| llama.cpp offline for an extended period | Medium | All call sites fall back gracefully: throttle unchanged; detectConflict unchanged; topic falls back to `extractTopicFallback` and logs `embedding_unavailable` |

Each step is an independent commit. Any step can be reverted without breaking the others.

## Changes from r1

| r1 issue | r2 fix |
|---|---|
| #1 Throttle set `ctx.candidates = []` which `ExtractMemoryCandidates` overwrites | Add `ctx.throttled` flag + first-line short-circuit in `ExtractMemoryCandidates` |
| #1 `fallbackReplies` not in task payload or parser | Add to `chat-flow.ts` enqueue + `parseMemoryExtractPayload` + `MemoryExtractContext` |
| #2 `embedding_fallback` reason cannot be recorded by caller | Add `EmbeddingResult.fallbackReason` field; rewrite `embedText` to tag fallback result |
| #3 SQL migration runner introduced | Drop migration runner; `CREATE TABLE IF NOT EXISTS` in `initializeDatabase()` |
| #4 `no_conflict` written 80 rows/task, conflicts with p95 target | Aggregate to 1 row per round with `detail.reasons`; console filter for `no_conflict` and `topic_fallback` behind `MEMORY_OP_VERBOSE_LOG` |
| #5 `feed_topics` per-deployment with raw `representative_text` | Scoped by `(user_id, world_id, agent_id)`; store embedding only, no raw text |
| #6 `extractTopic v1.1` overstates its scope | Explicit: only affects fallback path; LLM-success path unchanged; integration test asserts this |
| #7 `detectConflict` says "constants unchanged" but current code only handles preference | v1.1 REPLACES the preference-only rule with the full set; spec language updated |
| #7 `"我希望"` in `HYPOTHETICAL_TRIGGERS` causes false negative on long-term boundaries | Remove `"我希望"` / `"我想要"` from hypothetical triggers; check `LONG_TERM_MARKERS` BEFORE hypothetical guard |
| #8 `fallback_reply` claims to track fallback source | v1.1 only matches known static fallback text; structured-output-failure replies are not currently observable without restructuring `ChatReply` |
| (Step 0) Precondition about deferred v1.0 items | New `Precondition` section at top of spec |
