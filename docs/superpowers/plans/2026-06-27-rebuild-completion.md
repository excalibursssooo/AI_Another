# Rebuild Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the TypeScript-first rebuild so the current Next.js app builds, tests pass, and the remaining `Rebuild.md` architecture gaps are implemented behind verified server boundaries.

**Architecture:** Keep the active app under `ui/`. Stabilize the AI SDK structured-output contract first, then extend the model-purpose boundary, memory extraction, memory retrieval, feed generation, optional tools, and database migration/smoke-test support without reintroducing Python, Docker, Postgres, or Qdrant as default dependencies.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, AI SDK, Zod, Drizzle ORM, better-sqlite3, SQLite FTS5.

---

### Task 1: Restore AI Structured-Output Build And Tests

**Files:**
- Modify: `ui/src/server/ai/structured-output.ts`
- Modify: `ui/src/server/ai/structured-output.test.ts`
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/ai/chat.test.ts`

- [x] **Step 1: Confirm the current failures**

Run:

```bash
cd ui && npm run build
cd ui && npm run test:run -- src/server/ai/chat.test.ts src/server/ai/structured-output.test.ts
```

Expected:
- `npm run build` fails because `model` is passed to `withStructuredOutput()` but the options type does not accept it.
- AI tests fail because some assertions still expect legacy `generateText().text` JSON parsing while implementation now uses AI SDK `Output.object`.

- [x] **Step 2: Add a failing test for explicit model forwarding**

In `ui/src/server/ai/structured-output.test.ts`, add this test:

```typescript
it("uses an explicit model when one is provided", async () => {
  const explicitModel = { id: "explicit" };
  const mockOutput = {
    reply: "x",
    mood: { label: "calm" as const, intensity: 0.5, heartbeatBpm: 72 },
  };
  vi.mocked(generateText).mockResolvedValue({ output: mockOutput } as never);

  await withStructuredOutput({
    schema: ChatReplySchema,
    purpose: "chat",
    model: explicitModel as never,
    prompt: "hello",
  });

  const call = vi.mocked(generateText).mock.calls[0]![0] as Record<string, unknown>;
  expect(call.model).toBe(explicitModel);
});
```

Run:

```bash
cd ui && npm run test:run -- src/server/ai/structured-output.test.ts
```

Expected: TypeScript/test failure because `model` is not accepted by `withStructuredOutput()`.

- [x] **Step 3: Implement explicit model support**

Update `ui/src/server/ai/structured-output.ts` so the options include `model?: LanguageModel` and the selected model is:

```typescript
const model = explicitModel ?? getLanguageModel(purpose);
```

The implementation must still throw `StructuredOutputError` when no model is available and must still pass `Output.object({ schema })`, `system`, `prompt`, `temperature`, and `abortSignal` into `generateText()`.

- [x] **Step 4: Align chat AI tests with AI SDK structured output**

In `ui/src/server/ai/chat.test.ts`:
- Replace `generateText` output mocks for structured-output paths with `wso` mocks where `chat.ts` calls `withStructuredOutput()`.
- Keep parser helper tests (`stripThinkingBlocks`, `extractJsonPayload`, `parseJsonWithSchema`) only for the helper functions if they still exist.
- For `generateChatReply`, assert fallback on `StructuredOutputError` and rethrow behavior for non-structured unexpected errors only if that is the intended contract.
- For `generateWorldDraft`, assert `wso` receives `WorldDraftSchema`, `purpose: "world"`, prompt text, and explicit `model`.

Use this expected structured-output assertion shape:

```typescript
const callArgs = vi.mocked(wso).mock.calls[0][0];
expect(callArgs.schema).toBe(ChatReplySchema);
expect(callArgs.purpose).toBe("chat");
expect(callArgs.prompt).toContain("hi");
```

- [x] **Step 5: Verify the AI layer**

Run:

```bash
cd ui && npm run test:run -- src/server/ai/chat.test.ts src/server/ai/structured-output.test.ts
cd ui && npm run build
```

Expected: both AI test files pass and production build type-checks.

### Task 2: Normalize Model Purpose Boundaries

**Files:**
- Modify: `ui/src/server/ai/models.ts`
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/ai/structured-output.ts`
- Modify: `ui/src/server/ai/chat.test.ts`
- Modify: `ui/src/server/ai/structured-output.test.ts`
- Modify: `.env.example`

- [x] **Step 1: Write failing tests for purpose-specific env selection**

Add tests in `ui/src/server/ai/chat.test.ts` or a dedicated `models.test.ts` proving:

```typescript
expect(getLanguageModel("agentCreator")).not.toBeNull();
expect(getLanguageModel("worldCreator")).not.toBeNull();
expect(getLanguageModel("memory")).not.toBeNull();
expect(getLanguageModel("feed")).not.toBeNull();
```

with provider `minimax`, `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, and each role-specific model env set.

Run:

```bash
cd ui && npm run test:run -- src/server/ai/chat.test.ts
```

Expected: fail because `ModelPurpose` does not include the new purpose names.

- [x] **Step 2: Extend `ModelPurpose`**

Change `ModelPurpose` to:

```typescript
export type ModelPurpose = "chat" | "memory" | "agentCreator" | "worldCreator" | "feed";
```

Map env vars as:

```typescript
const purposeEnvKeyByPurpose: Record<ModelPurpose, string> = {
  chat: "CHAT_MODEL",
  memory: "MEMORY_MODEL",
  agentCreator: "AGENT_CREATOR_MODEL",
  worldCreator: "WORLD_CREATOR_MODEL",
  feed: "FEED_MODEL",
};
```

Fallback remains `CHAT_MODEL` when the role-specific model is empty.

- [x] **Step 3: Update callers**

Update call sites:
- `generateChatReply` uses `purpose: "chat"`.
- `generateAgentDraft` uses `getLanguageModel("agentCreator")` and `purpose: "agentCreator"`.
- `generateWorldDraft` uses `getLanguageModel("worldCreator")` and `purpose: "worldCreator"`.

Update `withStructuredOutput()` accepted purpose type to `ModelPurpose`.

- [x] **Step 4: Verify model boundary**

Run:

```bash
cd ui && npm run test:run -- src/server/ai/chat.test.ts src/server/ai/structured-output.test.ts
cd ui && npm run build
```

Expected: tests and build pass.

### Task 3: Add Memory Extract Flow

**Files:**
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/ai/schemas.ts`
- Create: `ui/src/server/flow/memory-extract-flow.ts`
- Create: `ui/src/server/flow/memory-extract-flow.test.ts`
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/flow/chat-flow.test.ts`
- Modify: `ui/src/server/domain/chat/task-repository.ts`
- Modify: `ui/src/server/domain/chat/task-repository.test.ts`

- [x] **Step 1: Write failing tests for LLM memory extraction**

Create `ui/src/server/flow/memory-extract-flow.test.ts` with tests proving:
- It loads the user/assistant message pair from input.
- It calls a generated memory extraction function using `MemoryExtractionSchema`.
- It persists at most 8 candidate memories.
- It skips empty candidates.

Use this fixture:

```typescript
const extracted = {
  memories: [
    {
      subject: "user" as const,
      type: "preference" as const,
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    },
  ],
};
```

Run:

```bash
cd ui && npm run test:run -- src/server/flow/memory-extract-flow.test.ts
```

Expected: fail because the flow does not exist.

- [x] **Step 2: Implement `generateMemoryExtraction()`**

Add a function in `ui/src/server/ai/chat.ts`:

```typescript
export async function generateMemoryExtraction(input: {
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
}): Promise<MemoryExtraction | null> {
  if (isMockProvider()) return { memories: [] };
  const model = getLanguageModel("memory");
  if (!model) return null;
  return withStructuredOutput({
    schema: MemoryExtractionSchema,
    purpose: "memory",
    model,
    system: MEMORY_SYSTEM_PROMPT,
    prompt: `用户: ${input.userMessage}\n角色: ${input.assistantMessage}`,
    temperature: 0.2,
  }).catch(() => null);
}
```

- [x] **Step 3: Implement `createMemoryExtractFlow()`**

The flow nodes must be:
- `LoadMessagePair`
- `ExtractMemoryCandidates`
- `PersistMemories`

Persist using `MemoryRepository.create()` with `memoryType: candidate.type`.

- [x] **Step 4: Replace rule-based `extractSimpleMemory()` usage**

In `ChatFlow`, stop calling `extractSimpleMemory()` directly. Enqueue a `memory_extract` task with:

```typescript
{
  userId: ctx.userId,
  agentId: ctx.agentId,
  worldId: ctx.worldId,
  conversationId: ctx.conversationId,
  userMessage: ctx.input,
  assistantMessage: ctx.reply ?? "",
}
```

Keep the reply non-blocking.

- [x] **Step 5: Verify memory extraction**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/memory-extract-flow.test.ts src/server/flow/chat-flow.test.ts
```

Expected: tests pass and ChatFlow no longer uses rule-only memory extraction.

### Task 4: Upgrade Memory Recall With SQLite FTS5 Scoring

**Files:**
- Modify: `ui/src/server/db/client.ts`
- Modify: `ui/src/server/db/schema.ts`
- Modify: `ui/src/server/domain/chat/repositories.ts`
- Modify: `ui/src/server/domain/chat/repositories.test.ts`

- [x] **Step 1: Write failing tests for ranked recall**

Add repository tests proving:
- Memories matching text rank above unrelated high-importance memories.
- Recent memories receive a small boost.
- `access_count` and `last_accessed_at` update after recall.

Run:

```bash
cd ui && npm run test:run -- src/server/domain/chat/repositories.test.ts
```

Expected: fail because current recall uses `LIKE` and does not update access metadata.

- [x] **Step 2: Add FTS table and triggers**

In `initializeDatabase()`, create:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
USING fts5(id UNINDEXED, content, tokenize='unicode61');
```

Add insert/update/delete sync behavior in repository methods. If SQLite trigger support is used, keep it in `initializeDatabase()`; otherwise explicitly maintain the FTS table in repository methods.

- [x] **Step 3: Implement scoring**

`MemoryRepository.recall()` must compute:

```text
score = textScore * 0.45 + importance * 0.25 + recency * 0.15 + relationshipBoost * 0.15
```

Use exact `userId`, `agentId`, `worldId`, active status, and query text. Keep deterministic fallback when query is empty.

- [x] **Step 4: Verify recall**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/chat/repositories.test.ts src/server/flow/chat-flow.test.ts
```

Expected: ranked recall tests pass and ChatFlow still passes.

### Task 5: Make Feed Generation AI-Backed

**Files:**
- Modify: `ui/src/server/ai/schemas.ts`
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/flow/feed-flow.ts`
- Modify: `ui/src/server/flow/feed-flow.test.ts`

- [x] **Step 1: Write failing tests for AI feed generation**

Update `feed-flow.test.ts` to inject a fake generator returning:

```typescript
{
  content: "小伴：今天想把雨声记下来。",
  topicSeed: "雨声",
  postType: "reflection"
}
```

Assert the persisted post uses these generated fields.

Run:

```bash
cd ui && npm run test:run -- src/server/flow/feed-flow.test.ts
```

Expected: fail because `createFeedGenerateFlow()` does not accept or call a generator.

- [x] **Step 2: Add `FeedPostDraftSchema` and generator**

Add Zod schema:

```typescript
export const FeedPostDraftSchema = z.object({
  content: z.string().min(1),
  topicSeed: z.string().min(1),
  postType: z.enum(["status", "reflection", "plan"]),
});
```

Add `generateFeedPostDraft()` using `purpose: "feed"` and `FEED_MODEL`.

- [x] **Step 3: Update FeedFlow nodes**

FeedFlow nodes must be:
- `LoadAgent`
- `LoadWorld`
- `LoadRecentMessages`
- `LoadLiveState`
- `GenerateFeedPost`
- `PersistFeedPost`

Keep a deterministic fallback only when provider is mock or generation fails.

- [x] **Step 4: Verify feed flow**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/feed-flow.test.ts
```

Expected: AI-backed flow tests pass.

### Task 6: Wire Optional Low-Risk Tools Into Chat

**Files:**
- Modify: `ui/src/server/flow/chat-flow.ts`
- Modify: `ui/src/server/ai/chat.ts`
- Modify: `ui/src/server/tools/registry.ts`
- Modify: `ui/src/server/tools/registry.test.ts`
- Modify: `ui/src/server/flow/chat-flow.test.ts`

- [x] **Step 1: Write failing tests for tool gating**

Add tests proving:
- `ENABLE_TOOLS=false` does not pass tools to generation.
- `ENABLE_TOOLS=true` passes only `searchMemories`, `createTaskDraft`, and `createFeedPostDraft`.

Run:

```bash
cd ui && npm run test:run -- src/server/flow/chat-flow.test.ts src/server/tools/registry.test.ts
```

Expected: fail because tools are defined but not wired into ChatFlow.

- [x] **Step 2: Add optional tools to chat generation input**

Extend `ChatGenerationInput` with:

```typescript
tools?: ReturnType<typeof createChatToolSet>;
```

Pass tools into `generateText()` only when present.

- [x] **Step 3: Gate by feature flag**

In ChatFlow, create tools only when:

```typescript
process.env.ENABLE_TOOLS === "true"
```

Use current `userId`, `agentId`, `worldId`, and `db`.

- [x] **Step 4: Verify tools**

Run:

```bash
cd ui && npm run test:run -- src/server/flow/chat-flow.test.ts src/server/tools/registry.test.ts
```

Expected: tool tests pass and no high-risk tools are exposed.

### Task 7: Add Drizzle Config, Migration Path, And Smoke Scripts

**Files:**
- Create: `ui/drizzle.config.ts`
- Create: `ui/scripts/dev-seed.ts`
- Create: `ui/scripts/smoke-chat.ts`
- Modify: `ui/package.json`
- Modify: `README.md`

- [x] **Step 1: Add smoke script tests or dry-run commands**

Add package scripts:

```json
{
  "db:generate": "drizzle-kit generate",
  "dev:seed": "tsx scripts/dev-seed.ts",
  "smoke:chat": "tsx scripts/smoke-chat.ts"
}
```

Run:

```bash
cd ui && npm run smoke:chat
```

Expected: fail before scripts exist.

- [x] **Step 2: Add Drizzle config**

Create `ui/drizzle.config.ts` pointing at `src/server/db/schema.ts` and `DATABASE_URL || file:./data/another-world.sqlite`.

- [x] **Step 3: Add seed script**

`dev-seed.ts` imports `getDatabase()` and verifies default world and default agent exist.

- [x] **Step 4: Add smoke chat script**

`smoke-chat.ts` runs `createChatFlow({ db: getDatabase() })` with:

```typescript
{
  userId: process.env.DEV_USER_ID || "u001",
  agentId: "agent-default",
  worldId: "default",
  input: "你好，请用一句话回复我。"
}
```

It prints the reply and exits non-zero if `reply` or `doneEvent` is missing.

- [x] **Step 5: Verify smoke path**

Run:

```bash
cd ui && npm run dev:seed
cd ui && npm run smoke:chat
```

Expected: both commands exit 0 with `AI_PROVIDER=mock`.

### Task 8: Final Verification And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-06-27-rebuild-completion.md`

- [x] **Step 1: Run full verification**

Run:

```bash
cd ui && npm run test:run
cd ui && npm run build
cd ui && npm run smoke:chat
```

Expected: all commands exit 0.

Result:
- `npm run test:run` passed: 16 files, 111 tests.
- `npm run build` passed.
- `npm run dev:seed` passed.
- `npm run smoke:chat` passed with `AI_PROVIDER=mock`.
- `git diff --check` passed.

- [x] **Step 2: Update README**

Document:
- default local run uses Next.js API routes and SQLite;
- `AI_PROVIDER=mock` is deterministic;
- provider env vars for DeepSeek/OpenAI/Anthropic/Google/Minimax;
- memory extraction and feed generation are structured-output flows;
- tools are disabled unless `ENABLE_TOOLS=true`.

- [x] **Step 3: Mark this plan complete**

Check off completed tasks in this file and leave any intentional deferred work under a `Deferred` heading with a concrete reason.

### Deferred

No Rebuild.md completion items are intentionally deferred in this pass.

### Code Review Follow-Up

- [x] Fix FTS memory recall to query memory ids through the external-content table rowid join instead of selecting a nonexistent `id` column from `memories_fts`.
- [x] Add recall regression coverage for wildcard prefix FTS queries and access metadata updates.
- [x] Add a task worker that claims `memory_extract` tasks, runs `MemoryExtractFlow`, and marks tasks done or failed.
- [x] Trigger bounded background task draining from `/api/chat` after the SSE done event is emitted.
- [x] Wrap AI SDK structured-output generation failures in `StructuredOutputError` so chat fallback handling remains active.
- [x] Scope `agent_live_states` by `(user_id, agent_id)` in runtime SQLite, Drizzle schema, repository upsert, and legacy local DB migration.
- [x] Add feed generation coverage for AI structured draft fields being persisted.
