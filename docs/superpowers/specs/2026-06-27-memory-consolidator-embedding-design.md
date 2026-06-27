# Embedding Memory Consolidator Design

## Goal

Build a lightweight memory quality layer for the TypeScript-first AI role engine. New extracted memories should be embedded, compared against existing active memories in the same user/agent/world scope, then merged, frozen, or inserted according to deterministic rules.

This closes the main remaining gap from `Rebuild.md`: the current memory extraction flow persists every candidate directly, which will accumulate duplicates and stale facts over long-term use.

## Scope

Included:

- Store embeddings and embedding metadata on `memories`.
- Add an embedding client for a local llama.cpp embedding server.
- Fall back to deterministic local embeddings when llama.cpp is unavailable, without treating fallback vectors as semantic embeddings.
- Add a `MemoryConsolidator` that handles merge, conflict, and create decisions.
- Add canonical `key` and `topic` fields to memory candidates and persisted memories so comparison pools are narrower than broad `subject=user`.
- Route `MemoryExtractFlow` through the consolidator.
- Add tests for embeddings, migration, consolidation, and flow integration.
- Document how to run the local embedding server.

Not included:

- Qdrant, pgvector, Redis, or a separate vector database.
- LLM-based conflict judging.
- Automatic lifecycle management for `~/llama.cpp`.
- Full historical versioning or rollback UI.
- Large-scale approximate nearest-neighbor indexing.
- LLM-based canonical key/topic generation beyond the structured memory extraction schema.

## Architecture

The implementation keeps the current SQLite-first architecture.

`MemoryExtractFlow` will no longer call `MemoryRepository.create()` directly. It will pass each extracted memory candidate to `MemoryConsolidator`, which embeds the candidate, loads active memories in the same scope, scores embedding similarity, applies deterministic conflict rules, and then chooses one of four outcomes:

- `merged`: update an existing active memory with merged content and refreshed embedding.
- `conflicted`: freeze the old active memory and create a new active memory.
- `created`: create a new active memory.
- `skipped`: ignore an invalid candidate or a recoverable per-candidate failure.

The embedding layer lives under `src/server/ai` because it adapts model/provider infrastructure. The consolidation policy lives under `src/server/domain/chat` because it is domain behavior, not model plumbing.

## llama.cpp Embedding Backend

The first real embedding backend is a local llama.cpp server using an OpenAI-compatible embeddings endpoint.

Recommended local command:

```bash
cd ~/llama.cpp

./build/bin/llama-server \
  -m ~/models/embeddings/bge-m3/bge-m3-q8_0.gguf \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ngl 999 \
  --host 127.0.0.1 \
  --port 8080
```

Environment variables:

```env
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
LLAMA_EMBEDDING_MODEL=bge-m3
LLAMA_EMBEDDING_TIMEOUT_MS=5000
EMBEDDING_FALLBACK_DIMENSION=128
EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=false
```

Use `--host 0.0.0.0` only when LAN access is intentionally required. The default documentation keeps the embedding service bound to loopback for a local desktop assistant.

The client calls:

```text
POST {LLAMA_EMBEDDING_BASE_URL}/embeddings
```

with:

```json
{
  "model": "bge-m3",
  "input": "memory content"
}
```

The expected response is OpenAI-compatible:

```json
{
  "data": [
    {
      "embedding": [0.1, 0.2, 0.3]
    }
  ]
}
```

If the request fails, times out, returns a non-2xx response, or returns an invalid vector, the client returns a deterministic fallback embedding instead of throwing. Memory extraction must not fail just because the local embedding service is offline.

## Embedding Result Contract

`src/server/ai/embeddings.ts` exposes:

```ts
export type EmbeddingBackend = "llama.cpp" | "fallback";
export type EmbeddingQuality = "semantic" | "lexical" | "none";

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  backend: EmbeddingBackend;
  quality: EmbeddingQuality;
  model: string;
  version: number;
  needsRefresh: boolean;
}

export interface EmbedTextOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export async function embedText(text: string, options?: EmbedTextOptions): Promise<EmbeddingResult>;
```

Fallback embeddings must be deterministic for the same normalized text and dimension. They do not have semantic quality; they exist to keep tests and development stable when llama.cpp is unavailable.

Embedding quality rules:

- `llama.cpp` returns `quality: "semantic"` and can participate in semantic merge and conflict ranking.
- `fallback` returns `quality: "lexical"` and `needsRefresh: true`.
- fallback vectors must not participate in semantic cosine merge/conflict by default.
- fallback vectors may only support exact duplicate detection or lexical-safe merge.
- `EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=true` can override this for experiments, but it is off by default.

## Database Model

Extend `memories` with embedding metadata:

```text
canonical_key TEXT
topic TEXT
embedding_json TEXT
embedding_model TEXT
embedding_backend TEXT
embedding_quality TEXT
embedding_dimension INTEGER
embedding_status TEXT
embedding_text_hash TEXT
embedding_version INTEGER
embedding_needs_refresh INTEGER
embedding_updated_at INTEGER
superseded_by TEXT
superseded_reason TEXT
last_observed_at INTEGER
source_message_id TEXT
source_task_id TEXT
```

Runtime database initialization adds these columns with `ALTER TABLE` when missing. Drizzle schema mirrors the same fields.

`embedding_json` stores a JSON array of numbers in the first version. This is intentionally simple and inspectable. For a personal SQLite workload, scanning active memories and computing cosine similarity in application code is acceptable.

Embedding status values:

- `missing`: migrated or newly inserted memory has no embedding yet.
- `ready`: semantic embedding is valid for current `content`, model, and version.
- `fallback`: only fallback/lexical embedding is present and semantic refresh is needed.
- `stale`: content, model, pooling, or embedding version changed after embedding generation.
- `failed`: semantic embedding refresh failed.

`embedding_text_hash` is calculated from normalized content. If content changes and the hash no longer matches, the memory becomes `stale`.

`embedding_version` starts at `1`. It gives the project a clean way to refresh all vectors when the embedding model, pooling, normalization, or serialization strategy changes.

`superseded_by` records the active memory that replaced a frozen conflicting memory. This is more debuggable than `status='frozen'` alone.

## Repository Changes

`MemoryRepository.create()` accepts optional embedding metadata, canonical key/topic, and source metadata.

`MemoryRepository.updateMerged()` updates:

- `content`
- `importance`
- `confidence`
- `canonical_key`
- `topic`
- `embedding_json`
- `embedding_model`
- `embedding_backend`
- `embedding_quality`
- `embedding_dimension`
- `embedding_status`
- `embedding_text_hash`
- `embedding_version`
- `embedding_needs_refresh`
- `embedding_updated_at`
- `last_observed_at`
- `updated_at`

`MemoryRepository.listActiveForScope()` returns active memories for a user/agent/world scope, including embedding metadata.

`MemoryRepository.replaceConflicted()` atomically freezes the old memory and inserts the new active memory in one SQLite transaction:

```text
BEGIN IMMEDIATE;
insert new active memory;
update old memory set status='frozen', superseded_by=newId, superseded_reason=reason;
COMMIT;
```

If new memory creation fails, the old memory must remain active.

`MemoryRepository.mergeMemory()` atomically updates an existing memory with merged content and refreshed embedding metadata. It should also be implemented with a transaction so future evidence/source writes can be added without changing the consistency model.

Existing `setStatus()` remains available for API freeze/activate/delete operations, but conflict replacement uses `replaceConflicted()`.

## Consolidation Policy

`src/server/domain/chat/memory-consolidator.ts` owns the policy.

Memory candidates gain optional canonical fields:

```ts
export interface MemoryCandidate {
  subject: "user" | "agent" | "world";
  type: "profile" | "preference" | "relationship" | "event" | "goal" | "boundary" | "lore";
  key?: string;
  topic?: string;
  content: string;
  importance: number;
  confidence: number;
}
```

Examples:

- `key: "preference.reminder.evening"`, `topic: "reminders"`
- `key: "tooling.shell"`, `topic: "zsh"`
- `key: "project.ai_another.memory"`, `topic: "AI_Another"`

`key` is a canonical slot when the extractor can infer one. `topic` is a looser topical hint. The consolidator must work when either field is missing, but it should prefer them when present.

Inputs:

```ts
export interface ConsolidateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  candidate: MemoryCandidate;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
}
```

Output:

```ts
export type ConsolidationAction = "created" | "merged" | "conflicted" | "skipped";

export interface ConsolidationResult {
  action: ConsolidationAction;
  memoryId?: string;
  frozenMemoryId?: string;
  reason: string;
}
```

Thresholds:

```ts
export const MEMORY_MERGE_SIMILARITY = 0.86;
export const MEMORY_CONFLICT_SIMILARITY = 0.72;
export const MEMORY_MERGED_CONTENT_MAX_LENGTH = 500;
export const MEMORY_CONFLICT_TOP_K = 10;
```

Candidate selection:

- Same `userId`, `agentId`, `worldId`.
- Existing memory status is `active`.
- Same `memoryType`, or both types are in the conflict-capable set:

```ts
const CONFLICT_CAPABLE_TYPES = new Set([
  "profile",
  "preference",
  "relationship",
  "goal",
  "boundary",
]);
```

Comparison priority:

1. Same canonical `key` when both candidate and old memory have a key.
2. Same `topic` and same `subject` when key is missing.
3. Same `subject` plus valid semantic embedding similarity when neither key nor topic is available.

This avoids putting every `subject=user` memory into the same effective comparison bucket.

Similarity:

- Semantic cosine ranking uses only memories with a semantic embedding, valid stored vector, and matching dimension.
- Compute cosine similarity in application code.
- Skip malformed embeddings or dimension mismatches.
- fallback embeddings are not semantic; use them only for exact duplicate or lexical-safe merge unless `EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=true`.
- Memories with `missing`, `fallback`, or `stale` status should be lazily re-embedded when llama.cpp is available before final ranking.

Decision order:

1. Normalize and validate the candidate. Empty or invalid candidates are skipped.
2. Generate candidate embedding. If the backend is fallback, mark the embedding as non-semantic and needing refresh.
3. Load active memories in the same user/agent/world scope.
4. For comparable memories with missing, stale, or fallback embeddings, lazily refresh embeddings when llama.cpp is available.
5. Filter comparable memories by memory type, canonical key/topic, and subject according to comparison priority.
6. Rank valid semantic embeddings by cosine similarity.
7. Check deterministic conflict rules across the top `MEMORY_CONFLICT_TOP_K` memories whose similarity is `>= MEMORY_CONFLICT_SIMILARITY`.
8. If a conflict is found, atomically freeze/supersede the old memory and create the new active memory.
9. If no conflict is found and the best semantic similarity is `>= MEMORY_MERGE_SIMILARITY`, atomically merge into the best old memory with refreshed embedding.
10. If semantic embedding is unavailable, allow only exact duplicate or lexical-safe merge.
11. Otherwise create a new active memory.

## Conflict Detection

The first version uses deterministic high-confidence rules. It does not try to solve every natural-language contradiction.

Conflict detection only runs after scope, subject, type, and similarity filters have already narrowed the candidate set.

Rule groups:

- Preference reversal:
  - positive: `喜欢`, `爱`, `偏好`, `想要`, `愿意`
  - negative: `不喜欢`, `讨厌`, `不想`, `避免`, `排斥`
- State reversal:
  - positive: `是`, `有`, `住在`, `从事`, `正在`
  - negative: `不是`, `没有`, `不再`, `已经不`, `离开`
- Boundary reversal:
  - positive: `可以`, `接受`, `愿意`, `允许`
  - negative: `不要`, `不能`, `拒绝`, `不接受`, `禁止`
- Goal reversal:
  - positive: `想`, `计划`, `希望`, `准备`
  - negative: `不想`, `放弃`, `取消`, `停止`

Matching rules:

- Match negative phrases before positive phrases.
- If a negative phrase matches, do not count a positive phrase contained inside it. For example, `不喜欢` must not also count as `喜欢`.
- Use phrase-level matching, not single-character matching.
- Handle obvious double negation conservatively. For example, `不是不喜欢咖啡` is not a negative preference.
- Do not let one-off temporal observations override long-term preferences. Phrases such as `今天`, `这次`, `临时`, `最近`, and `目前` reduce conflict confidence unless the candidate type is `profile` or a state-like `profile` entry rather than `preference`.
- Event-like memories do not freeze preference/boundary memories.

Examples:

- Old: `用户喜欢雨天散步`
- New: `用户讨厌雨天出门`
- Result: freeze old, create new.

- Old: `用户接受晚间提醒`
- New: `用户不要晚上提醒`
- Result: freeze old, create new.

Gray areas are not conflicts in version one:

- `用户喜欢咖啡` vs `用户最近少喝咖啡`
- `用户喜欢雨天散步` vs `用户今天没有出门`
- Different subjects or different worlds.

## Merge Behavior

Merging is deterministic and type-aware:

1. Normalize whitespace.
2. If old content contains new content, keep old content.
3. If new content contains old content, use new content.
4. Apply the memory-type strategy below.
5. Clamp at a sentence boundary where possible, never by blindly cutting a Chinese sentence in the middle unless no boundary exists.

Type strategies:

- `preference` and `boundary`: keep the latest clear expression and merge useful conditions. Example: `用户偏好本地小模型，尤其是 10B 以下、能端侧 JSON 输出的模型。`
- `profile`: prefer the more specific current fact. If two facts describe different slots, keep both only when key/topic differs.
- `goal`: merge only when key/topic matches the same project or goal. Different projects create separate memories.
- `relationship`: merge only when the relationship target is the same key/topic.
- `event`: avoid broad merging; events are often time-specific.
- `lore`: merge only inside the same world/topic.

Fallback concatenation with `old；new` is allowed only when both memories share key/topic and no type-specific strategy can produce a clearer sentence.

Scores:

- `importance = max(old.importance, candidate.importance)`
- `confidence = max(old.confidence, candidate.confidence)`

The merged content receives a fresh embedding.

## Error Handling

- llama.cpp unavailable: return fallback embedding and continue.
- fallback embedding does not authorize semantic merge/conflict by default; memory rows created with fallback are marked `embedding_status='fallback'` and `embedding_needs_refresh=1`.
- migrated memories start with `embedding_status='missing'` and `embedding_needs_refresh=1`.
- stale/fallback/missing memories are lazily refreshed during consolidation when llama.cpp is available.
- Candidate content empty after trim: skip candidate.
- Existing memory has malformed embedding JSON: skip that embedding for similarity.
- Existing memory dimension differs from candidate dimension: skip that memory for similarity.
- Single candidate consolidation fails unexpectedly: return `skipped` for that candidate and continue with the next one.
- Database write failure still fails the task, because persisted memory state would be unknown.

Concurrency:

- Consolidation for a single user/agent/world scope must be serialized by a SQLite `BEGIN IMMEDIATE` transaction that covers comparable-memory reads, decision-making, and writes.
- This avoids two concurrent `memory_extract` tasks both observing no comparable memory and creating duplicate active memories.
- If future work adds an application-level queue per scope, the transaction remains the final consistency boundary.

## Flow Integration

`MemoryExtractFlow` changes from direct persistence to consolidation:

```text
LoadMessagePair
ExtractMemoryCandidates
ConsolidateMemories
```

When available, the flow passes `source_message_id` and `source_task_id` to the consolidator. The existing task payload does not yet include message IDs, so v1 treats these fields as nullable and records `source_task_id` from the task worker when available.

`persistedMemoryCount` becomes the count of candidates that resulted in `created`, `merged`, or `conflicted`. It does not count `skipped`.

The task worker behavior remains unchanged: it claims `memory_extract`, runs the flow, and marks tasks done or failed.

## Testing

Required tests:

- `embedText()` parses a valid llama.cpp/OpenAI-compatible embedding response.
- `embedText()` falls back when fetch fails.
- fallback embeddings are deterministic for the same input.
- fallback embeddings do not participate in semantic merge by default.
- database initialization adds embedding columns.
- repository creates and reads embedding metadata.
- migrated active memories without embedding are marked missing/needs refresh.
- similar same-scope memories merge instead of duplicating.
- conflicting memories freeze old and create new.
- top 1 non-conflicting but top 2 conflicting still produces a conflict.
- unrelated memories create new records.
- dimension mismatches do not crash consolidation.
- missing/stale/fallback embeddings are lazily refreshed when a semantic backend is available.
- `embedding_text_hash` changes when content changes, and stale embeddings are refreshed before semantic comparison.
- `不喜欢` does not simultaneously match `喜欢`.
- temporal one-off statements do not freeze long-term preferences.
- conflict freeze/create is atomic; if creation fails, the old memory remains active.
- two concurrent consolidations in the same scope do not create duplicate active exact memories.
- same subject but different key/topic does not merge.
- fallback dimension mismatch with future llama.cpp vectors can be refreshed instead of permanently skipping the row.
- `MemoryExtractFlow` calls the consolidator and reports the right count.

Verification commands:

```bash
cd ui
npm run test:run
npm run lint
npm run build
```

Optional local llama.cpp smoke:

```bash
cd ui
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1 npm run test:run -- src/server/ai/embeddings.test.ts
```

## Acceptance Criteria

- New memory candidates no longer always create duplicate rows.
- High-similarity non-conflicting candidates merge into existing active memories.
- High-similarity conflicting candidates freeze the old memory and create a new active memory.
- fallback embeddings preserve write availability but do not drive semantic decisions.
- Existing memories without embeddings can be refreshed lazily and then compared.
- Conflict detection checks the topK similar semantic memories, not only the single best match.
- Conflict replacement and merge writes are transactional.
- The app still runs when llama.cpp is offline.
- Unit tests do not require llama.cpp.
- No Python backend, Qdrant, Postgres, Redis, or external vector database is introduced.
