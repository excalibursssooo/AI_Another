# Embedding Memory Consolidator Design

## Goal

Build a lightweight memory quality layer for the TypeScript-first AI role engine. New extracted memories should be embedded, compared against existing active memories in the same user/agent/world scope, then merged, frozen, or inserted according to deterministic rules.

This closes the main remaining gap from `Rebuild.md`: the current memory extraction flow persists every candidate directly, which will accumulate duplicates and stale facts over long-term use.

## Scope

Included:

- Store embeddings and embedding metadata on `memories`.
- Add an embedding client for a local llama.cpp embedding server.
- Fall back to deterministic local embeddings when llama.cpp is unavailable.
- Add a `MemoryConsolidator` that handles merge, conflict, and create decisions.
- Route `MemoryExtractFlow` through the consolidator.
- Add tests for embeddings, migration, consolidation, and flow integration.
- Document how to run the local embedding server.

Not included:

- Qdrant, pgvector, Redis, or a separate vector database.
- LLM-based conflict judging.
- Automatic lifecycle management for `~/llama.cpp`.
- Full historical versioning or rollback UI.
- Large-scale approximate nearest-neighbor indexing.

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
  --host 0.0.0.0 \
  --port 8080
```

Environment variables:

```env
LLAMA_EMBEDDING_BASE_URL=http://localhost:8080/v1
LLAMA_EMBEDDING_MODEL=bge-m3
LLAMA_EMBEDDING_TIMEOUT_MS=5000
EMBEDDING_FALLBACK_DIMENSION=128
```

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
export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  backend: "llama.cpp" | "fallback";
  model: string;
}

export interface EmbedTextOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export async function embedText(text: string, options?: EmbedTextOptions): Promise<EmbeddingResult>;
```

Fallback embeddings must be deterministic for the same normalized text and dimension. They do not need semantic quality; they exist to keep tests and development stable when llama.cpp is unavailable.

## Database Model

Extend `memories` with embedding metadata:

```text
embedding_json TEXT
embedding_model TEXT
embedding_backend TEXT
embedding_dimension INTEGER
embedding_updated_at INTEGER
```

Runtime database initialization adds these columns with `ALTER TABLE` when missing. Drizzle schema mirrors the same fields.

`embedding_json` stores a JSON array of numbers in the first version. This is intentionally simple and inspectable. For a personal SQLite workload, scanning active memories and computing cosine similarity in application code is acceptable.

## Repository Changes

`MemoryRepository.create()` accepts optional embedding metadata.

`MemoryRepository.updateMerged()` updates:

- `content`
- `importance`
- `confidence`
- `embedding_json`
- `embedding_model`
- `embedding_backend`
- `embedding_dimension`
- `embedding_updated_at`
- `updated_at`

`MemoryRepository.listActiveForScope()` returns active memories for a user/agent/world scope, including embedding metadata.

Existing `setStatus()` remains the path for freezing an old conflicting memory.

## Consolidation Policy

`src/server/domain/chat/memory-consolidator.ts` owns the policy.

Inputs:

```ts
export interface ConsolidateMemoryInput {
  userId: string;
  agentId: string;
  worldId: string;
  candidate: MemoryCandidate;
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
```

Candidate selection:

- Same `userId`, `agentId`, `worldId`.
- Existing memory status is `active`.
- Same `subject`.
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

Similarity:

- Compare only memories with a valid stored embedding and matching dimension.
- Compute cosine similarity in application code.
- Skip malformed embeddings or dimension mismatches.

Decision order:

1. Generate embedding for the candidate.
2. Find active comparable memories.
3. Sort comparable memories by cosine similarity descending.
4. For the first memory with similarity `>= MEMORY_CONFLICT_SIMILARITY`, check deterministic conflict rules.
5. If conflict is detected, freeze the old memory and create the new candidate as active.
6. Otherwise, if best similarity is `>= MEMORY_MERGE_SIMILARITY`, merge into the best old memory.
7. Otherwise, create a new memory.

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

Merging is deterministic:

1. Normalize whitespace.
2. If old content contains new content, keep old content.
3. If new content contains old content, use new content.
4. Otherwise join as `old；new`.
5. Clamp to `MEMORY_MERGED_CONTENT_MAX_LENGTH`.

Scores:

- `importance = max(old.importance, candidate.importance)`
- `confidence = max(old.confidence, candidate.confidence)`

The merged content receives a fresh embedding.

## Error Handling

- llama.cpp unavailable: return fallback embedding and continue.
- Candidate content empty after trim: skip candidate.
- Existing memory has malformed embedding JSON: skip that embedding for similarity.
- Existing memory dimension differs from candidate dimension: skip that memory for similarity.
- Single candidate consolidation fails unexpectedly: return `skipped` for that candidate and continue with the next one.
- Database write failure still fails the task, because persisted memory state would be unknown.

## Flow Integration

`MemoryExtractFlow` changes from direct persistence to consolidation:

```text
LoadMessagePair
ExtractMemoryCandidates
ConsolidateMemories
```

`persistedMemoryCount` becomes the count of candidates that resulted in `created`, `merged`, or `conflicted`. It does not count `skipped`.

The task worker behavior remains unchanged: it claims `memory_extract`, runs the flow, and marks tasks done or failed.

## Testing

Required tests:

- `embedText()` parses a valid llama.cpp/OpenAI-compatible embedding response.
- `embedText()` falls back when fetch fails.
- fallback embeddings are deterministic for the same input.
- database initialization adds embedding columns.
- repository creates and reads embedding metadata.
- similar same-scope memories merge instead of duplicating.
- conflicting memories freeze old and create new.
- unrelated memories create new records.
- dimension mismatches do not crash consolidation.
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
LLAMA_EMBEDDING_BASE_URL=http://localhost:8080/v1 npm run test:run -- src/server/ai/embeddings.test.ts
```

## Acceptance Criteria

- New memory candidates no longer always create duplicate rows.
- High-similarity non-conflicting candidates merge into existing active memories.
- High-similarity conflicting candidates freeze the old memory and create a new active memory.
- The app still runs when llama.cpp is offline.
- Unit tests do not require llama.cpp.
- No Python backend, Qdrant, Postgres, Redis, or external vector database is introduced.
