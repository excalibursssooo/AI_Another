# Memory Quality v1.1 Design

## Goal

Extend yesterday's `2026-06-27-memory-consolidator-embedding-design.md` with four targeted improvements that target the largest remaining quality gaps in the memory pipeline **without reopening the deliberate design decisions** in that document:

1. Reduce unnecessary LLM cost by short-circuiting memory extraction before the model is called.
2. Reduce false-positive memory freezes from the deterministic conflict detector.
3. Make embedding fallback, conflict skips, and topic fallback **observable** instead of silent.
4. Improve feed `extractTopic` quality from "first 4 words" to embedding-clustered topic keys.

This is **v1.1**, not v2. No schema migration on `memories`. No new external dependencies. No changes to `MemoryExtractFlow`'s public surface.

## Scope

In scope:

- A new `ThrottleMemoryExtraction` flow node that short-circuits `MemoryExtractFlow` before the memory LLM is called.
- A new `src/server/domain/chat/throttle-rules.ts` module with a pure-function rule set.
- `detectConflict` returns `{ conflict, reason }` instead of `boolean`. The existing `detectConflictForTest` boolean wrapper stays so old tests do not break.
- A new `memory_operation_logs` SQLite table and a `MemoryOperationLogRepository` that writes one row per significant memory-pipeline event. `record()` never throws.
- Console.info / console.warn lines co-located with each `record()` call so logs are visible in dev without a metrics stack.
- A new `feed_topics` SQLite table and a `FeedTopicRepository` that backs an embedding-clustered `extractTopicWithCluster` in `feed-flow.ts`.
- Migration files that add the two new tables idempotently.
- Drizzle schema updates that mirror the new tables.
- Tests for every new code path, plus integration coverage on `MemoryExtractFlow`.

Out of scope:

- Using embeddings for memory recall (rejected by yesterday's spec — `memories_fts` + lexical scoring only).
- Touching `drainChatTasks` invocation (`api/chat/route.ts` already calls it correctly).
- Changing the merge / conflict thresholds (0.72 / 0.86 / top_k=10 stay).
- Changing the merge `appendByType` / `clampContent` logic (yesterday's spec already constrains content).
- Replacing `extractTopic` with an LLM call.
- Async batched logging, log TTL cleanup, Prometheus exporter, `/admin/logs` endpoint.
- Changing `MemoryExtractFlow` payload shape (no `recentMessages` in v1.1).

## Architecture

The four changes are orthogonal. They share one new table, `memory_operation_logs`. They do not modify any existing table.

```
chat-flow  ─► tasks.enqueue(memory_extract)
                  │
                  ▼
            MemoryExtractFlow
            ├── LoadMessagePair
            ├── ThrottleMemoryExtraction   ◄── NEW (#3)
            │     │
            │     ├─ rule hit → MemoryOperationLogRepository.record(kind='throttled')
            │     │                candidates = []  (LLM never called)
            │     │
            │     └─ pass through
            │
            ├── ExtractMemoryCandidates
            │     └─ generateMemoryExtraction (memory LLM)
            │
            └── ConsolidateMemories
                  ├── embedText
                  │     └─ fallback  ─► caller catches ─► record(kind='embedding_fallback')  (#6)
                  │
                  ├── detectConflict v1.1   ◄── CHANGED (#4)
                  │     ├─ conflict → freeze old + create new
                  │     │                + record(kind='conflict')
                  │     │
                  │     └─ no conflict → for every checked item,
                  │                       record(kind='no_conflict', reason=...)
                  │
                  └── create / merge / skip

feed-flow  ─► extractTopicWithCluster   ◄── CHANGED (#5)
            ├── embedText(content)
            │     └─ fallback → extractTopicFallback + record(kind='topic_fallback', reason='embedding_unavailable')
            │
            ├── FeedTopicRepository.match(cosine ≥ 0.75, last_used ≤ 90d)
            │     ├─ hit  → use_count += 1, last_used_at = now
            │     └─ miss → new topic_key from extractTopicFallback
            │              + record(kind='topic_fallback', reason='table_empty_cold_start' | 'no_match_in_window')
            │
            └── return topic_key
```

Boundary rules:

- **#3 throttle is task-worker level throttling, not enqueue-level throttling.** Memory extraction tasks are still created per chat turn; only the heavy LLM call inside them is short-circuited.
- **`embedText()` does not know scope.** Fallback recording happens at the caller (`MemoryConsolidator`, `extractTopicWithCluster`), not inside `embedText` itself.
- **`MemoryOperationLogRepository.record()` never throws.** A logging failure cannot affect the chat / feed path. `try { record(...) } catch { console.error(...) }` inside the repository.
- **`MemoryExtractFlow` public surface unchanged.** `ChatFlow` callers do not need updates beyond passing `fallbackReplies` in the task payload.

## #3 — ThrottleMemoryExtraction

### Node placement

A new node inserted between `LoadMessagePair` and `ExtractMemoryCandidates` in `createMemoryExtractFlow`:

```
LoadMessagePair
ThrottleMemoryExtraction   ◄── NEW
ExtractMemoryCandidates
ConsolidateMemories
```

If throttled, `ctx.candidates = []` is set. `ExtractMemoryCandidates` still runs but `ctx.candidates ?? []` evaluates to `[]` so `generateMemoryExtraction` is never called.

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

1. **`fallback_reply`** — `assistantMessage` is in the injected `fallbackReplies` list (case-insensitive, trimmed equality).
2. **`punctuation_only`** — after stripping CJK + Latin letters + digits, ≥ 70% of remaining chars are punctuation OR whitespace.
3. **`repeated_punctuation`** — any single punctuation char (`。！？!?，,；;…`) appears ≥ 3 times in a row in either message.
4. **`repeated_chars`** — any single non-punctuation char appears ≥ 5 times in a row in either message (catches `哈哈哈哈哈`, `啊啊啊啊啊`).
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

Whitelists are short and conservative. New triggers are added only after observing a real false-positive in `memory_operation_logs`.

### `containsAny` matching semantics

All whitelist lookups in this spec use the same `containsAny(haystack, needles)` helper:

```ts
function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}
```

- CJK phrases: substring match (e.g. `"我喜欢"` matches `"我喜欢咖啡"`).
- English phrases: substring match too, since the trigger list is already chosen to be unambiguous (`"don't"` matches `"don't call me"`).
- Matching is **case-sensitive for CJK** (irrelevant) and **case-insensitive for English** (lowercased before compare).
- No word-boundary awareness. The whitelist phrases are short and distinctive enough that substring matching is safe.

### Fallback replies injection

`ChatFlow.EnqueueMemoryExtraction` adds `fallbackReplies` to the task payload. The default list lives in `chat-flow.ts` and contains:

- `generateChatReply`'s mockProvider fallback: `"我在这里。你刚才说的我记住了。"`
- `generateChatReply`'s `fallbackReply()` return value
- Any reply that came back from `withStructuredOutput` throwing `StructuredOutputError`

High-risk safety replies (`assessRisk === "high"`) are **not** included because `SafetyCheck` blocks them before `EnqueueMemoryExtraction`.

### Logging

On any `ThrottleDecision.throttled === true`:

```ts
new MemoryOperationLogRepository(db).record({
  userId, agentId, worldId,
  kind: "throttled",
  reason: decision.reason!,
  sourceTaskId: ctx.sourceTaskId ?? null,
});
```

### Expected impact

- High-frequency casual users: 50–70% of turns short-circuited.
- Average users: 20–40% short-circuited.
- Long focused sessions: < 10% short-circuited.
- LLM cost for memory extraction should drop by at least 30% in mixed traffic.

## #4 — detectConflict v1.1

### Signature change (backward compatible)

```ts
// Before
function detectConflict(oldContent: string, newContent: string, memoryType: string): boolean;

// After
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

function detectConflict(oldContent: string, newContent: string, memoryType: string): ConflictDecision;
```

`detectConflictForTest(old, new, type): boolean` continues to exist as `return detectConflict(old, new, type).conflict;`. All existing tests continue to pass without modification.

### Decision flow

```ts
function detectConflict(old, new, type): ConflictDecision {
  if (!CONFLICT_CAPABLE_TYPES.has(type)) {
    return { conflict: false, reason: "type_not_conflict_capable" };
  }
  if (containsAny(new, HYPOTHETICAL_TRIGGERS)) {
    return { conflict: false, reason: "hypothetical_context" };
  }
  if (containsAny(old, DOUBLE_NEGATIVE_PHRASES) || containsAny(new, DOUBLE_NEGATIVE_PHRASES)) {
    return { conflict: false, reason: "double_negative" };
  }
  const isLongTermType = type === "preference" || type === "boundary";
  const oldTemporal = containsAny(old, TEMPORAL_TRIGGERS);
  const newTemporal = containsAny(new, TEMPORAL_TRIGGERS);
  if (isLongTermType && (oldTemporal || newTemporal) && !containsAny(new, LONG_TERM_MARKERS)) {
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

The existing `polarityOf`, `POSITIVE_PHRASES`, `NEGATIVE_PHRASES`, `DOUBLE_NEGATIVE_PHRASES`, `CONFLICT_CAPABLE_TYPES` constants stay unchanged.

### New phrase tables

```ts
const HYPOTHETICAL_TRIGGERS = [
  "如果", "要是", "假如", "假设", "要是能", "要是我",
  "我希望", "我想要", "我希望不是",
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

### Consolidation integration

`MemoryConsolidator.consolidate()` calls `detectConflict` per item inside the topK window. Every checked item — including ones that did **not** trigger — gets a `no_conflict` log entry:

```ts
const conflictChecks = ranked
  .filter((item) => item.similarity >= MEMORY_CONFLICT_SIMILARITY)
  .slice(0, MEMORY_CONFLICT_TOP_K)
  .map((item) => ({
    item,
    decision: detectConflict(item.memory.content, content, input.candidate.type),
  }));

const logs = new MemoryOperationLogRepository(options.db);
for (const { item, decision } of conflictChecks) {
  if (!decision.conflict) {
    logs.record({
      userId: input.userId, agentId: input.agentId, worldId: input.worldId,
      kind: "no_conflict",
      reason: decision.reason,
      detail: { similarity: item.similarity, comparedMemoryId: item.memory.id },
      sourceTaskId: input.sourceTaskId ?? null,
    });
  }
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

`ConsolidationResult.reason` becomes a composite string: `conflict:high_confidence_reversal` / `merged:similar_semantic_memory` / `created:no_comparable_semantic_memory`. Existing downstream consumers that treat `reason` as opaque continue to work.

### Tradeoffs accepted

- **No LLM judge in v1.1.** The user explicitly chose to lower false positives rather than maximize recall of all reversals.
- **Thresholds untouched.** `MEMORY_CONFLICT_SIMILARITY = 0.72` and `MEMORY_MERGE_SIMILARITY = 0.86` stay. The cosine layer is independent of the polarity layer.
- **`CONFLICT_CAPABLE_TYPES` unchanged.** Event-like memories remain non-conflictable.
- **Phrasing false negatives.** A user saying `"我重新想了一下，觉得我不喜欢这个"` triggers hypothetical (`我想了一下`) and skips freeze — a known limitation, accepted because the same reversal typically appears in a subsequent turn without the hypothetical wrapper.

## #5 — extractTopic v1.1

### New table

```sql
CREATE TABLE feed_topics (
  topic_key TEXT PRIMARY KEY,
  representative_text TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_quality TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX idx_feed_topics_last_used ON feed_topics(last_used_at DESC);
```

`feed_topics` is **per-deployment, not per-user**. Topics are clustering concepts shared across users. This is intentional — `memories` already provides per-user personalization.

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

  if (embedding.quality !== "semantic") {
    logs.record({ kind: "topic_fallback", reason: "embedding_unavailable", sourceTaskId: input.sourceTaskId ?? null, ...input });
    return extractTopicFallback(input.content);
  }

  const recent = topics.listRecent({ sinceDays: TOPIC_RECENT_WINDOW_DAYS });
  if (recent.length === 0) {
    const key = topics.create({ topicKey: extractTopicFallback(input.content), representativeText: input.content, embedding });
    logs.record({ kind: "topic_fallback", reason: "table_empty_cold_start", sourceTaskId: input.sourceTaskId ?? null, ...input });
    return key;
  }

  const matched = bestMatchByCosine(recent, embedding, TOPIC_MATCH_SIMILARITY);
  if (matched) {
    topics.touch(matched.topicKey);
    return matched.topicKey;
  }

  const key = topics.create({ topicKey: extractTopicFallback(input.content), representativeText: input.content, embedding });
  logs.record({ kind: "topic_fallback", reason: "no_match_in_window", sourceTaskId: input.sourceTaskId ?? null, ...input });
  return key;
}
```

### `FeedTopicRepository` API contract

`src/server/domain/chat/feed-topic-repository.ts`:

```ts
export interface FeedTopicRecord {
  topicKey: string;
  representativeText: string;
  embeddingJson: string;
  embeddingModel: string;
  embeddingQuality: string;
  embeddingDimension: number;
  useCount: number;
  firstSeenAt: number;
  lastUsedAt: number;
}

export interface CreateFeedTopicInput {
  topicKey: string;
  representativeText: string;
  embedding: EmbeddingResult;  // import from "@/server/ai/embeddings"
}

export interface ListRecentInput {
  sinceDays: number;  // only rows whose last_used_at >= now - sinceDays * 86400_000
}

export interface TopicMatch {
  topicKey: string;
  similarity: number;
}

export class FeedTopicRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateFeedTopicInput): string  // returns topicKey, idempotent on conflict (no-op)
  listRecent(input: ListRecentInput): FeedTopicRecord[]  // ORDER BY last_used_at DESC
  touch(topicKey: string): void  // use_count += 1, last_used_at = now
  isEmpty(): boolean  // convenience for cold-start detection
  bestMatchByCosine(
    candidates: FeedTopicRecord[],
    queryEmbedding: EmbeddingResult,
    threshold: number,
  ): TopicMatch | null  // returns highest-similarity match above threshold, or null
}
```

`bestMatchByCosine` is a pure function on the repository's data; it does **not** call the embedding service. `extractTopicWithCluster` calls `embedText` once, then asks the repo to find the nearest neighbour.

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

The original `extractTopic` function is renamed to `extractTopicFallback` and stays as the topic-key generator. `extractTopicWithCluster` is the new public entry point.

### What does **not** change

- `feed_posts.topic_seed` (the "what to talk about next" prompt field) is independent of `feed_posts.topic` and is left alone.
- `feed_posts.topic` schema is unchanged. The new logic only changes **how** the topic string is computed.

## #6 — memory_operation_logs

### Schema

```sql
CREATE TABLE memory_operation_logs (
  id TEXT PRIMARY KEY,                      -- mem-op-{uuid}
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- see enum
  reason TEXT NOT NULL,                     -- short subreason
  detail TEXT,                              -- JSON, metadata only, no PII
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
| `embedding_fallback` | `embedText` catch (recorded by caller) | `fetch_failed`, `non_2xx_status`, `invalid_response_shape`, `vector_dimension_zero` |
| `conflict` | #4 high-confidence reversal | `high_confidence_reversal` |
| `no_conflict` | #4 explicit non-conflict per checked item | `type_not_conflict_capable`, `hypothetical_context`, `double_negative`, `temporal_vs_long_term`, `polarity_unchanged_or_ambiguous` |
| `topic_fallback` | #5 embedding or cold-start fallback | `embedding_unavailable`, `table_empty_cold_start`, `no_match_in_window` |

### Repository

`src/server/domain/chat/memory-operation-log-repository.ts`:

```ts
export type MemoryOpKind =
  | "throttled"
  | "embedding_fallback"
  | "conflict"
  | "no_conflict"
  | "topic_fallback";

export interface MemoryOperationLogRecord { /* ... */ }

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
    }
    console.info("[memory-ops]", JSON.stringify({
      kind: input.kind,
      reason: input.reason,
      scope: `${input.userId}/${input.agentId}/${input.worldId}`,
      sourceTaskId: input.sourceTaskId ?? null,
      ts: Date.now(),
    }));
  }

  listRecent(input: { kind?: MemoryOpKind; limit?: number }): MemoryOperationLogRecord[] {
    // SELECT ... ORDER BY created_at DESC LIMIT ?
  }
}
```

`record()` is **synchronous** and **never throws**. This is critical: the chat SSE stream and the feed task both flow through `record()`, so a DB hiccup in the log table must not bubble up.

### Embedding fallback error classification

`src/server/ai/embeddings.ts` exposes a small classifier for the catch block:

```ts
export type EmbeddingFallbackReason =
  | "fetch_failed"
  | "non_2xx_status"
  | "invalid_response_shape"
  | "vector_dimension_zero";

export function classifyEmbeddingError(error: unknown): EmbeddingFallbackReason { /* ... */ }
```

The actual `record()` call happens at the **caller** (consolidator / topic extractor), since `embedText` does not know the scope.

### Migrations

Two new SQL migration files in `ui/src/server/db/migrations/`:

1. `2026-06-27-001-create-memory-operation-logs.sql`
2. `2026-06-27-002-create-feed-topics.sql`

Both use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. `db/client.ts` runs them in order during `getDatabase()`.

### What does **not** ship in v1.1

- No async batched logging.
- No log TTL cleanup.
- No `/admin/logs` route.
- No Prometheus / OpenTelemetry exporter.
- No retention policy. Logs grow indefinitely until a v2 cron job prunes rows older than 30 days.

## llama.cpp Backend (unchanged)

The llama.cpp embedding server setup from yesterday's spec stays unchanged. No new environment variables. `EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=false` remains the default.

## Database Model Changes

Summary:

- **No changes to `memories`**, `tasks`, `memories_fts`, `feed_posts`, `conversations`, `messages`, `agents`, `worlds`, `agent_live_states`.
- **New tables**: `memory_operation_logs`, `feed_topics`.
- **New Drizzle schema entries** mirror both tables.

## Error Handling

| Scenario | Behavior |
|---|---|
| llama.cpp unavailable | `embedText` returns fallback; caller records `embedding_fallback` |
| Memory LLM throws / structured output fails | `generateMemoryExtraction` returns `null` (existing); no extra log beyond yesterday's design |
| `detectConflict` returns hypothetical reason | No freeze; `no_conflict` log entry recorded |
| `extractTopicWithCluster` embedding fails | `topic_fallback` log + fallback path |
| `record()` itself fails | Caught, `console.error` only. Business path continues |
| Migration fails on startup | Existing migration policy applies: startup aborts (preserves yesterday's behavior) |
| feed_topics table grows beyond 1000 rows | Not auto-pruned; admin queries the table manually. v2 cron job will prune. |

## Testing

### Unit tests

| File | Coverage |
|---|---|
| `throttle-rules.test.ts` (new) | All 7 reasons hit and miss; whitelists override `too_short` / `low_signal_non_cjk`; `fallbackReplies` injection works |
| `memory-consolidator.test.ts` (extended) | New `ConflictDecision` returns for each of 6 reasons; `detectConflictForTest` still returns boolean |
| `memory-operation-log-repository.test.ts` (new) | `record()` does not throw on DB error; `listRecent` orders correctly |
| `feed-topic-repository.test.ts` (new) | `create` / `listRecent` / `touch` / `bestMatchByCosine` |
| `feed-flow.test.ts` (extended) | `extractTopicWithCluster` cold-start / hit / miss paths; `extractTopicFallback` clamp |
| `embeddings.test.ts` (extended) | `classifyEmbeddingError` returns the right `EmbeddingFallbackReason` for each error type |

### Integration tests

| Scenario | Assertion |
|---|---|
| Throttled input | `generateMemoryExtraction` spy never called; one `throttled` row in `memory_operation_logs` |
| Hypothetical conflict input | `detectConflict` returns `hypothetical_context`; old memory stays `active`; one `no_conflict` row |
| Long-term marker input (`"以后不要 X"`) | `detectConflict` returns `high_confidence_reversal`; old memory `frozen`; one `conflict` row |
| Embedding fallback during consolidation | `MemoryOperationLogRepository.record({ kind: 'embedding_fallback', ... })` called once |
| `extractTopicWithCluster` cold-start | First call writes one `feed_topics` row, returns its key, logs `topic_fallback` cold-start |
| `extractTopicWithCluster` hit | Cosine ≥ 0.75 against existing topic: `use_count += 1`, no new topic created, no log row |
| 90-day window | Manually back-date `last_used_at`; new similar content creates a new topic, logs `no_match_in_window` |

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

2. **Conflict false positives drop.**
   - All existing `memory-consolidator.test.ts` cases pass unchanged.
   - 10 hypothetical inputs (`"如果 X"`, `"我希望 Y"`): 0 freezes, 10 `no_conflict` rows.
   - 5 temporary inputs on long-term preferences: 0 freezes, 5 `temporal_vs_long_term` rows.

3. **Embedding fallback is observable.**
   - Disable the llama.cpp server. Run 5 consolidation rounds. `memory_operation_logs` has ≥ 5 `embedding_fallback` rows; console shows matching `[memory-ops]` lines.

4. **Topic clustering works.**
   - Write 3 semantically related feed contents (`"今天喝了咖啡"`, `"刚泡了咖啡"`, `"咖啡真好喝"`). `feed_topics` ends with 1 row, `use_count = 3`.
   - Write 1 unrelated feed content (`"加班到深夜"`). `feed_topics` ends with 2 rows.

5. **Backward compatibility.**
   - `detectConflictForTest()` boolean wrapper still exists; old test suite passes without edits.
   - `memories` table schema unchanged.
   - Yesterday's spec Acceptance Criteria all still hold.

6. **Logging does not regress latency.**
   - Synthetic load: p95 chat-flow latency increases by < 1ms after `record()` calls are wired in.

7. **No new external dependencies.**
   - `package.json` is unchanged.

## File Change Manifest

```
NEW
  ui/src/server/domain/chat/throttle-rules.ts
  ui/src/server/domain/chat/throttle-rules.test.ts
  ui/src/server/domain/chat/memory-operation-log-repository.ts
  ui/src/server/domain/chat/memory-operation-log-repository.test.ts
  ui/src/server/domain/chat/feed-topic-repository.ts
  ui/src/server/domain/chat/feed-topic-repository.test.ts
  ui/src/server/db/migrations/2026-06-27-001-create-memory-operation-logs.sql
  ui/src/server/db/migrations/2026-06-27-002-create-feed-topics.sql

MODIFY
  ui/src/server/flow/memory-extract-flow.ts                   # add ThrottleMemoryExtraction node + fallbackReplies payload
  ui/src/server/flow/memory-extract-flow.test.ts              # new throttle + log integration
  ui/src/server/flow/chat-flow.ts                             # pass fallbackReplies in EnqueueMemoryExtraction payload
  ui/src/server/flow/feed-flow.ts                             # extractTopicWithCluster + rename extractTopic → extractTopicFallback
  ui/src/server/flow/feed-flow.test.ts                        # new cluster + fallback tests
  ui/src/server/domain/chat/memory-consolidator.ts            # ConflictDecision, conflictChecks loop, record() calls
  ui/src/server/domain/chat/memory-consolidator.test.ts       # new decision-flow + hypothetical / temporal cases
  ui/src/server/db/schema.ts                                  # mirror memory_operation_logs + feed_topics
  ui/src/server/db/client.ts                                  # run new migrations on getDatabase()
  ui/src/server/ai/embeddings.ts                              # expose classifyEmbeddingError
  ui/src/server/ai/embeddings.test.ts                         # classifyEmbeddingError coverage

DOCS
  docs/superpowers/specs/2026-06-27-memory-quality-v1.1-design.md     # this file
  docs/superpowers/plans/2026-06-27-memory-quality-v1.1.md            # produced by writing-plans skill
```

## Migration Order

The implementation must follow this order so each step is independently verifiable:

1. **DB migrations** first. `memory_operation_logs` and `feed_topics` are created. Existing tables untouched.
2. **Drizzle schema** mirror of both tables.
3. **`MemoryOperationLogRepository`** standalone. `record()` and `listRecent()` only. No callers yet — covered by unit tests.
4. **`FeedTopicRepository`** standalone. Same pattern.
5. **`classifyEmbeddingError`** in `embeddings.ts`. Caller-side log hooks can now reference a stable reason.
6. **#4 detectConflict v1.1**. Replace `detectConflict` body to return `ConflictDecision`. Keep `detectConflictForTest` boolean wrapper. Wire `record()` calls inside `consolidate()`. Run the existing test suite first; it should pass unchanged. Then add new cases.
7. **#3 throttle**. Add `ThrottleMemoryExtraction` node. Add `fallbackReplies` to chat-flow task payload. Wire `record()` in the throttle node. Run integration tests.
8. **#5 topic clustering**. Add `extractTopicWithCluster`. Wire `record()` calls. Run feed-flow tests.
9. After each step: `npm run test:run && npm run lint && npm run build`.

## Risks and Rollback

| Risk | Probability | Mitigation |
|---|---|---|
| New migration breaks startup | Low | `CREATE TABLE IF NOT EXISTS`; rollback is `DROP TABLE` of the two new tables |
| Throttle over-blocks | Medium | Strong-memory whitelist covers known important phrases; observe `throttled` log ratio for one week post-deploy; alert if > 80% |
| `detectConflict` v1.1 breaks existing tests | Low | Boolean wrapper preserved; new tests in independent `describe` blocks |
| `feed_topics` grows unboundedly in cold start | Medium | 90-day window limits match candidates; row count manually reviewed after one week; v2 cron prunes `last_used_at < 30d` |
| Logging write latency | Low | Synchronous single-row INSERT, sub-millisecond; no batching in v1.1 |
| llama.cpp offline for an extended period | Medium | All three call sites fall back gracefully: throttle unchanged; detectConflict unchanged; topic falls back to `extractTopicFallback` and logs `embedding_unavailable` |

Each step is an independent commit. Any step can be reverted without breaking the other three.
