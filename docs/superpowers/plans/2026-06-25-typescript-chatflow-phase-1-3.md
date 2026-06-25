# TypeScript ChatFlow Phase 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the active chat path into the existing `ui/` Next.js app with TypeScript server modules, SQLite persistence, and compatible API routes.

**Architecture:** Keep the current `ui/` app in place. Add thin Next.js route handlers under `ui/src/app/api`, reusable server modules under `ui/src/server`, and use SQLite through Drizzle repositories. Non-core APIs required by the frontend return compatibility stubs.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Drizzle ORM, better-sqlite3, AI SDK, Zod, nanoid, Zustand.

---

### Task 1: Test Harness And Client Base URL

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/src/lib/api/client.ts`
- Create: `ui/src/lib/api/client.test.ts`

- [ ] **Step 1: Write failing tests for same-origin API URLs**

```typescript
import { describe, expect, it } from "vitest";

import { buildApiUrl, resolveApiBaseUrl } from "./client";

describe("API client URL resolution", () => {
  it("uses same-origin /api by default", () => {
    expect(resolveApiBaseUrl({ nodeEnv: "development" })).toBe("/api");
    expect(buildApiUrl("/chat", "/api")).toBe("/api/chat");
  });

  it("keeps absolute configured API base URLs", () => {
    expect(resolveApiBaseUrl({ nodeEnv: "development", apiBaseUrl: "http://127.0.0.1:8000" })).toBe(
      "http://127.0.0.1:8000",
    );
    expect(buildApiUrl("/chat", "http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/chat");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd ui && npm run test:run -- src/lib/api/client.test.ts`

Expected: command fails because `test:run`, `buildApiUrl`, or `resolveApiBaseUrl` is not defined.

- [ ] **Step 3: Add Vitest and URL helpers**

Add scripts and dependencies, then export `resolveApiBaseUrl()` and `buildApiUrl()` from `client.ts`. Default base URL is `/api`; production still allows an explicit `NEXT_PUBLIC_API_BASE_URL`.

- [ ] **Step 4: Run test and verify pass**

Run: `cd ui && npm run test:run -- src/lib/api/client.test.ts`

Expected: tests pass.

### Task 2: Flow Runner

**Files:**
- Create: `ui/src/server/flow/types.ts`
- Create: `ui/src/server/flow/runner.ts`
- Create: `ui/src/server/flow/runner.test.ts`

- [ ] **Step 1: Write failing Flow runner tests**

```typescript
import { describe, expect, it } from "vitest";

import { Flow } from "./runner";
import { FlowEvent, FlowNode } from "./types";

describe("Flow", () => {
  it("runs nodes in order and emits lifecycle events", async () => {
    type Ctx = { value: string };
    const nodes: FlowNode<Ctx>[] = [
      { name: "first", run: async (ctx) => ({ value: `${ctx.value}a` }) },
      { name: "second", run: async (ctx) => ({ value: `${ctx.value}b` }) },
    ];
    const events: FlowEvent[] = [];

    const result = await new Flow(nodes).run({ value: "" }, (event) => {
      events.push(event);
    });

    expect(result.value).toBe("ab");
    expect(events.map((event) => `${event.type}:${event.node}`)).toEqual([
      "node:start:first",
      "node:end:first",
      "node:start:second",
      "node:end:second",
    ]);
  });

  it("emits an error event before rethrowing node failures", async () => {
    const flow = new Flow<{ value: string }>([
      {
        name: "fail",
        run: async () => {
          throw new Error("boom");
        },
      },
    ]);
    const events: FlowEvent[] = [];

    await expect(flow.run({ value: "" }, (event) => events.push(event))).rejects.toThrow("boom");
    expect(events).toContainEqual({ type: "error", node: "fail", message: "boom" });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd ui && npm run test:run -- src/server/flow/runner.test.ts`

Expected: command fails because the runner files do not exist.

- [ ] **Step 3: Implement minimal Flow runner**

Create `FlowEvent`, `FlowNode`, and `Flow` with sequential execution, lifecycle events, and error events.

- [ ] **Step 4: Run test and verify pass**

Run: `cd ui && npm run test:run -- src/server/flow/runner.test.ts`

Expected: tests pass.

### Task 3: SQLite Schema And Repositories

**Files:**
- Create: `ui/src/server/db/schema.ts`
- Create: `ui/src/server/db/client.ts`
- Create: `ui/src/server/domain/chat/repositories.ts`
- Create: `ui/src/server/domain/chat/repositories.test.ts`

- [ ] **Step 1: Write failing repository tests**

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { AgentRepository, ConversationRepository, MemoryRepository, WorldRepository } from "./repositories";

describe("chat repositories", () => {
  it("seeds defaults and persists conversation turns", () => {
    const db = createTestDatabase();
    const agents = new AgentRepository(db);
    const worlds = new WorldRepository(db);
    const conversations = new ConversationRepository(db);

    expect(agents.listActive("default")).toHaveLength(1);
    expect(worlds.list()).toHaveLength(1);

    const conversationId = conversations.ensureConversation({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
    });
    conversations.appendMessage({ conversationId, role: "user", content: "hello" });
    conversations.appendMessage({ conversationId, role: "assistant", content: "hi" });

    expect(conversations.recentMessages(conversationId, 5).map((item) => item.content)).toEqual(["hello", "hi"]);
  });

  it("stores and recalls active memories for an agent", () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    memories.create({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      subject: "user",
      memoryType: "preference",
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    });

    const recalled = memories.recall({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      query: "雨天",
      limit: 5,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toContain("雨天");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd ui && npm run test:run -- src/server/domain/chat/repositories.test.ts`

Expected: command fails because database modules do not exist.

- [ ] **Step 3: Implement schema, database factory, seed, and repositories**

Use `better-sqlite3` and Drizzle. `createTestDatabase()` uses an in-memory SQLite database. `getDatabase()` uses `DATABASE_URL` or `file:./data/another-world.sqlite` and initializes tables lazily.

- [ ] **Step 4: Run test and verify pass**

Run: `cd ui && npm run test:run -- src/server/domain/chat/repositories.test.ts`

Expected: tests pass.

### Task 4: AI Adapter And ChatFlow

**Files:**
- Create: `ui/src/server/ai/schemas.ts`
- Create: `ui/src/server/ai/chat.ts`
- Create: `ui/src/server/flow/chat-flow.ts`
- Create: `ui/src/server/flow/chat-flow.test.ts`

- [ ] **Step 1: Write failing ChatFlow tests**

```typescript
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { createChatFlow } from "./chat-flow";

describe("ChatFlow", () => {
  it("persists user and assistant messages and returns done-compatible data", async () => {
    const db = createTestDatabase();
    const flow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "我在这里。",
        mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
    });

    expect(result.reply).toBe("我在这里。");
    expect(result.doneEvent?.agent_id).toBe("agent-default");
    expect(result.doneEvent?.persisted_memory_count).toBeGreaterThanOrEqual(0);
    expect(result.recentMessages?.map((item) => item.content)).toEqual(["你好", "我在这里。"]);
  });

  it("blocks high risk input before model generation", async () => {
    const db = createTestDatabase();
    let called = false;
    const flow = createChatFlow({
      db,
      generateChatReply: async () => {
        called = true;
        throw new Error("should not call model");
      },
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "我要自杀",
    });

    expect(called).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.reply).toContain("我在这里");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd ui && npm run test:run -- src/server/flow/chat-flow.test.ts`

Expected: command fails because ChatFlow does not exist.

- [ ] **Step 3: Implement ChatFlow and model adapter**

Implement the explicit nodes from the design. The default model adapter supports `AI_PROVIDER=mock` and graceful fallback when a configured provider fails or has no key.

- [ ] **Step 4: Run test and verify pass**

Run: `cd ui && npm run test:run -- src/server/flow/chat-flow.test.ts`

Expected: tests pass.

### Task 5: Next.js API Routes And Stubs

**Files:**
- Create: `ui/src/app/api/chat/route.ts`
- Create: `ui/src/app/api/agents/route.ts`
- Create: `ui/src/app/api/agents/[agentId]/state/live/route.ts`
- Create: `ui/src/app/api/conversations/route.ts`
- Create: `ui/src/app/api/memories/route.ts`
- Create: `ui/src/app/api/world/debug/route.ts`
- Create: `ui/src/app/api/worlds/route.ts`
- Create: `ui/src/app/api/posts/route.ts`
- Create: `ui/src/app/api/agents/[agentId]/generate-post/route.ts`
- Create: `ui/src/app/api/posts/[postId]/trigger-chat/route.ts`
- Create: `ui/src/server/api/dto.ts`

- [ ] **Step 1: Write route-level tests or focused DTO tests**

Add tests for DTO conversion functions in `ui/src/server/api/dto.test.ts` so route handlers have stable mappings without needing a live Next server.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd ui && npm run test:run -- src/server/api/dto.test.ts`

Expected: command fails because DTO helpers do not exist.

- [ ] **Step 3: Implement routes and DTO helpers**

Every SQLite-backed route exports `runtime = "nodejs"`. Stub feed and AI creation routes return explicit phase-limited responses instead of invoking AI features.

- [ ] **Step 4: Run route DTO tests and verify pass**

Run: `cd ui && npm run test:run -- src/server/api/dto.test.ts`

Expected: tests pass.

### Task 6: Verification

**Files:**
- Modify only files touched by earlier tasks if verification reveals issues.

- [ ] **Step 1: Run focused tests**

Run: `cd ui && npm run test:run`

Expected: all Vitest tests pass.

- [ ] **Step 2: Run lint**

Run: `cd ui && npm run lint`

Expected: command exits 0.

- [ ] **Step 3: Run production build**

Run: `cd ui && npm run build`

Expected: command exits 0.

- [ ] **Step 4: Inspect git diff**

Run: `git status --short` and `git diff --stat`

Expected: changes are limited to `docs/superpowers`, `ui/package.json`, lockfile updates, and `ui/src`.
