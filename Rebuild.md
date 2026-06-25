可以。我的建议是：**这次不要做“Python → TypeScript 的机械迁移”，而是把 AI_Another 重构成一个 TypeScript-first 的轻量 AI 角色工作流平台。**

核心判断如下：

> **技术底座：Next.js 全栈 + TypeScript + AI SDK + Drizzle + SQLite。**
> **工作流底座：借鉴 PocketFlow 的 Node/Flow 思路，但自己实现一个极小 Flow Runner。**
> **不要引入 LangChain / Mastra / pi-agent 作为核心。**
> **保留“角色、世界、记忆、动态、长期关系”这些产品核心。**

当前项目的 Python 后端已经承担了 FastAPI 路由、服务初始化、JWT、telemetry、chat、agent、memory、world、feed、task 等大量职责，`api/main.py` 变成了很重的入口文件。它现在的主链路本质是固定流程：安全检查、最近会话、记忆召回、回复生成、会话写入、记忆写入。  所以这不是一个需要重型 autonomous agent 框架的场景，而是一个需要**明确、可测试、可组合的 AI workflow** 的场景。

---

# 一、最终技术选型

## 1. 全栈框架：Next.js App Router

建议保留 Next.js，但把 Python FastAPI 后端删除，改成：

```text
Next.js UI
  +
Next.js Route Handlers / Server Actions
  +
TypeScript server modules
```

Next.js Route Handler 可以直接用 Web `Request` / `Response` API 创建自定义接口，并支持 `GET / POST / PUT / PATCH / DELETE / OPTIONS` 等方法。([Next.js][1])

也就是说，你不再需要：

```text
ui 运行在 :3000
FastAPI 运行在 :8000
CORS
JWT demo token
Python venv
Postgres + Qdrant docker compose
```

而是：

```text
pnpm dev
一个 Next.js app 同时提供 UI 和 API
```

这会大幅降低开发复杂度。

---

## 2. LLM Provider：Vercel AI SDK

不再使用 OpenRouter。建议使用：

```bash
pnpm add ai zod
pnpm add @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/deepseek
```

后续可选：

```bash
pnpm add @ai-sdk/groq @ai-sdk/xai @ai-sdk/mistral
```

AI SDK 的定位就是 TypeScript AI 应用和 agent 工具包；官方文档说明它提供统一 API，用于 text、structured objects、tool calls 和 agents，并支持 React、Next.js、Vue、Svelte、Node.js 等环境。([AI SDK][2])

它的 Provider 架构正好符合你的需求：用统一接口抽象不同模型供应商，避免被单一 API 锁死。官方列出的 provider 包包括 `@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/deepseek`、`@ai-sdk/groq`、`@ai-sdk/mistral`、`@ai-sdk/xai`、`@ai-sdk/deepinfra` 等。([AI SDK][3])

这里的关键不是“Vercel 部署”，而是 **AI SDK 的 provider 抽象**。

你后续可以这样配置：

```ts
// src/server/ai/models.ts
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { deepseek } from "@ai-sdk/deepseek";

export type ModelRole =
  | "chat"
  | "memory"
  | "agentCreator"
  | "worldCreator"
  | "feed";

export function getModel(role: ModelRole) {
  const provider = process.env.AI_PROVIDER ?? "deepseek";

  if (provider === "openai") {
    return openai(process.env.CHAT_MODEL ?? "gpt-4.1-mini");
  }

  if (provider === "anthropic") {
    return anthropic(process.env.CHAT_MODEL ?? "claude-sonnet-4.5");
  }

  if (provider === "google") {
    return google(process.env.CHAT_MODEL ?? "gemini-2.5-flash");
  }

  return deepseek(process.env.CHAT_MODEL ?? "deepseek-chat");
}
```

这样你可以在 `.env` 里切：

```env
AI_PROVIDER=deepseek
CHAT_MODEL=deepseek-chat
MEMORY_MODEL=deepseek-chat
AGENT_CREATOR_MODEL=deepseek-chat
```

---

## 3. 结构化输出：AI SDK + Zod

当前 Python 代码里，`ReplyGenerator`、`FeedGenerator`、`MemoryExtractor`、`AgentAttributeGenerator` 都在各自手写 JSON prompt、JSON parse、JSON repair。

重构后统一用 AI SDK 的 structured output。AI SDK 官方支持用 Zod / JSON schema 约束结构化输出，并在生成后校验。([AI SDK][4])

比如聊天结果：

```ts
// src/server/ai/schemas.ts
import { z } from "zod";

export const MoodSchema = z.object({
  label: z.enum(["calm", "happy", "sad", "anxious", "angry", "focused", "neutral"]),
  intensity: z.number().min(0).max(1),
  heartbeatBpm: z.number().int().min(55).max(130),
});

export const ChatReplySchema = z.object({
  reply: z.string().min(1),
  mood: MoodSchema,
});
```

生成：

```ts
import { generateText, Output } from "ai";
import { ChatReplySchema } from "./schemas";
import { getModel } from "./models";

export async function generateRoleReply(input: {
  system: string;
  user: string;
}) {
  const result = await generateText({
    model: getModel("chat"),
    output: Output.object({ schema: ChatReplySchema }),
    system: input.system,
    prompt: input.user,
  });

  return result.output;
}
```

这样就不需要到处写“请严格输出 JSON”+ repair 逻辑。

---

## 4. 数据层：Drizzle + SQLite

建议默认：

```bash
pnpm add drizzle-orm better-sqlite3
pnpm add -D drizzle-kit @types/better-sqlite3
```

Drizzle 是轻量 TypeScript ORM，官方强调它是 headless、SQL-like、typesafe、轻量、serverless-ready，并支持 SQLite / Postgres / MySQL 等驱动。([Drizzle ORM][5])

`better-sqlite3` 是 Node.js 下简单高性能的 SQLite 库，支持事务、同步 API、虚拟表和扩展。([GitHub][6])

这比当前默认 Postgres + Qdrant 轻很多。当前项目 `.env.example` 默认依赖 `POSTGRES_DSN`、`QDRANT_URL`、`QDRANT_COLLECTION`，并通过 docker-compose 起 Postgres 和 Qdrant。  这对早期产品迭代过重。

推荐策略：

```text
默认：SQLite + FTS5
可选：libSQL / Turso
后期：Postgres + pgvector
不再默认：Qdrant
```

---

# 二、项目重构后的目录结构

我建议不要一上来搞复杂 monorepo。当前阶段用**单 Next.js 项目 + src/server 分层**即可。

```text
AI_Another/
  package.json
  next.config.ts
  drizzle.config.ts
  .env.example

  src/
    app/
      page.tsx
      api/
        chat/route.ts
        agents/route.ts
        agents/[agentId]/route.ts
        worlds/route.ts
        memories/route.ts
        feed/route.ts
        health/route.ts

    features/
      chat/
      agents/
      worlds/
      feed/
      memory/

    server/
      config/
        env.ts

      db/
        index.ts
        schema.ts
        migrations/

      ai/
        models.ts
        schemas.ts
        generate.ts
        prompts/

      flow/
        types.ts
        runner.ts
        chat.flow.ts
        agent-create.flow.ts
        memory-extract.flow.ts
        feed-generate.flow.ts

      domain/
        agents/
          agent.service.ts
          agent.repo.ts
          agent.types.ts
        worlds/
          world.service.ts
          world.repo.ts
          world.types.ts
        conversations/
          conversation.repo.ts
          conversation.types.ts
        memories/
          memory.service.ts
          memory.repo.ts
          memory.retriever.ts
          memory.extractor.ts
          memory.types.ts
        feed/
          feed.service.ts
          feed.repo.ts
          feed.generator.ts
        safety/
          safety.service.ts
        state/
          live-state.service.ts

      tools/
        registry.ts
        task.tools.ts
        memory.tools.ts

      jobs/
        queue.ts
        workers.ts

    shared/
      types.ts
      contracts.ts
      ids.ts
```

这里的重点是：

```text
app/api 只负责 HTTP
server/domain 负责业务
server/flow 负责 AI 工作流编排
server/ai 负责模型调用
server/db 负责持久化
features 负责 UI
```

---

# 三、核心架构：PocketFlow 风格的轻量工作流

你不需要引入 PocketFlow 本身。你需要的是它背后的思想：

> **Node 是单一职责步骤，Flow 是显式图，状态通过 Context 传递。**

实现一个极小 runner 即可。

```ts
// src/server/flow/types.ts
export type FlowEvent =
  | { type: "node:start"; node: string }
  | { type: "node:end"; node: string }
  | { type: "delta"; content: string }
  | { type: "error"; node: string; message: string };

export interface FlowNode<TCtx> {
  name: string;
  run(ctx: TCtx, emit?: (event: FlowEvent) => void | Promise<void>): Promise<TCtx>;
}

export class Flow<TCtx> {
  constructor(private nodes: FlowNode<TCtx>[]) {}

  async run(ctx: TCtx, emit?: (event: FlowEvent) => void | Promise<void>) {
    let current = ctx;

    for (const node of this.nodes) {
      await emit?.({ type: "node:start", node: node.name });

      try {
        current = await node.run(current, emit);
      } catch (error) {
        await emit?.({
          type: "error",
          node: node.name,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      await emit?.({ type: "node:end", node: node.name });
    }

    return current;
  }
}
```

然后聊天工作流：

```ts
// src/server/flow/chat.flow.ts
export const chatFlow = new Flow<ChatContext>([
  loadAgentNode,
  loadWorldNode,
  safetyCheckNode,
  loadRecentTurnsNode,
  recallMemoriesNode,
  buildPromptNode,
  generateReplyNode,
  persistConversationNode,
  updateLiveStateNode,
  enqueueMemoryExtractionNode,
]);
```

这个结构比当前 `SessionOrchestrator` 更适合长期扩展。当前 orchestrator 的职责已经包括安全检查、历史读取、召回、回复生成、会话写入、记忆抽取和异步写入。  重构后每一步可以独立测试、替换、打日志。

---

# 四、聊天主链路设计

## ChatContext

```ts
export interface ChatContext {
  userId: string;
  agentId: string;
  worldId: string;
  input: string;

  agent?: Agent;
  world?: World;
  recentMessages?: ConversationMessage[];
  recalledMemories?: MemoryItem[];

  prompt?: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };

  reply?: string;
  mood?: {
    label: string;
    intensity: number;
    heartbeatBpm: number;
  };

  blocked?: boolean;
  riskLevel?: "low" | "medium" | "high";
}
```

## 主流程

```text
1. LoadAgentNode
2. LoadWorldNode
3. SafetyCheckNode
4. LoadRecentMessagesNode
5. RecallMemoriesNode
6. BuildPromptNode
7. GenerateReplyNode
8. PersistConversationNode
9. UpdateLiveStateNode
10. EnqueueMemoryExtractionNode
```

注意：**记忆抽取不阻塞回复。**
聊天体验优先，记忆写入可以放到轻量 job queue。

---

# 五、API 设计

## `/api/chat`

建议直接返回 AI SDK UI stream 或标准 SSE。

如果继续自定义 SSE：

```ts
// src/app/api/chat/route.ts
import { chatFlow } from "@/server/flow/chat.flow";

export async function POST(req: Request) {
  const body = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const emit = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      };

      try {
        const result = await chatFlow.run(
          {
            userId: body.userId,
            agentId: body.agentId,
            worldId: body.worldId ?? "default",
            input: body.message,
          },
          emit
        );

        emit({
          type: "done",
          reply: result.reply,
          mood: result.mood,
          recalledMemories: result.recalledMemories ?? [],
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
```

后续可以改成 AI SDK 的 `streamText()` 和 `toUIMessageStreamResponse()`。AI SDK 支持 `streamText`，也支持工具调用和多步工具执行。([AI SDK][7])

---

# 六、工具系统怎么做

你的项目当前不应该变成“开放式 agent 自动执行工具”。但是可以做一个**受控工具层**。

AI SDK 的工具由 `description`、`inputSchema`、`execute`、`strict` 等元素组成，schema 会被模型使用，也会用于校验工具调用。([AI SDK][7])

建议第一版只开放这类低风险工具：

```text
read_agent_profile
read_world_lore
search_memories
create_task_draft
create_feed_post_draft
```

不要开放：

```text
delete_memory
delete_agent
send_message_to_user
external network fetch
file system write
payment / account operation
```

工具层设计：

```ts
// src/server/tools/registry.ts
import { tool } from "ai";
import { z } from "zod";

export const tools = {
  searchMemories: tool({
    description: "Search long-term memories for the current user and agent.",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ query, limit }) => {
      return memoryService.search({ query, limit });
    },
  }),

  createTaskDraft: tool({
    description: "Create a draft task. It does not execute anything.",
    inputSchema: z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
    }),
    execute: async (input) => {
      return taskService.createDraft(input);
    },
  }),
};
```

AI SDK 还支持动态审批，例如根据工具输入决定是否需要 approval。([AI SDK][7]) 这对以后加入“角色帮你做事”很有用，但第一版不要过早复杂化。

---

# 七、数据模型设计

建议第一版 SQLite schema 如下。

```ts
// src/server/db/schema.ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  persona: text("persona").notNull(),
  background: text("background").notNull(),
  greeting: text("greeting").notNull(),
  speakingStyle: text("speaking_style").notNull(),
  hobbiesJson: text("hobbies_json").notNull().default("[]"),
  worldId: text("world_id").notNull().default("default"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const worlds = sqliteTable("worlds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lore: text("lore").notNull().default(""),
  tone: text("tone").notNull().default(""),
  constraintsJson: text("constraints_json").notNull().default("[]"),
  seedMemoriesJson: text("seed_memories_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull().default("default"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role").notNull(), // user | assistant | system | tool
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull().default("default"),
  subject: text("subject").notNull(), // user | agent | world
  type: text("type").notNull(),
  content: text("content").notNull(),
  importance: real("importance").notNull().default(0.5),
  confidence: real("confidence").notNull().default(0.5),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const feedPosts = sqliteTable("feed_posts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull().default("default"),
  content: text("content").notNull(),
  topicSeed: text("topic_seed").notNull(),
  postType: text("post_type").notNull().default("status"),
  status: text("status").notNull().default("published"),
  createdAt: integer("created_at").notNull(),
});
```

相比当前 Postgres schema，这个模型更统一。当前 Python 版本有 `memory_item`、`conversation_turn`、`feed_post`、`task_item`、`domain_config`、`agent_profile` 等表。 新模型保留能力，但命名和边界更清晰。

---

# 八、记忆系统设计

不要一开始做 Qdrant。先做：

```text
MemoryExtractor：LLM 抽取长期记忆
MemoryRetriever：SQLite FTS5 + importance + recency 排序
MemoryConsolidator：去重 / 合并 / 冲突
MemoryRepo：CRUD
```

第一版召回公式：

```text
score =
  textScore * 0.45
  + importance * 0.25
  + recency * 0.15
  + relationshipBoost * 0.15
```

记忆抽取 schema：

```ts
export const MemoryCandidateSchema = z.object({
  subject: z.enum(["user", "agent", "world"]),
  type: z.enum([
    "profile",
    "preference",
    "relationship",
    "event",
    "goal",
    "boundary",
    "lore",
  ]),
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export const MemoryExtractionSchema = z.object({
  memories: z.array(MemoryCandidateSchema).max(8),
});
```

抽取流程：

```text
聊天完成
→ 写入 messages
→ enqueue memory_extract job
→ 后台读取最近一轮
→ LLM 抽取候选记忆
→ 查重
→ 合并/写入
```

这样聊天不会被记忆写入拖慢。

---

# 九、工作流类型

至少四条 flow。

## 1. ChatFlow

```text
LoadAgent
LoadWorld
SafetyCheck
LoadRecentMessages
RecallMemories
BuildChatPrompt
GenerateReply
PersistConversation
UpdateLiveState
EnqueueMemoryExtraction
```

## 2. AgentCreateFlow

```text
NormalizeUserPrompt
LoadWorld
GenerateAgentProfile
ValidateAgentProfile
PersistAgent
SeedAgentMemories
ReturnAgent
```

## 3. MemoryExtractFlow

```text
LoadMessagePair
LoadExistingMemories
ExtractMemoryCandidates
ConsolidateMemories
PersistMemories
```

## 4. FeedGenerateFlow

```text
LoadAgent
LoadWorld
LoadRecentMessages
LoadLiveState
GenerateFeedPost
PersistFeedPost
```

当前项目已经有 AI 建角、记忆 seed、动态生成这些能力。比如 `AgentService.create_agent_by_ai_debug()` 会结合 world/domain 生成角色。 `FeedGenerator` 会基于角色设定、最近对话和心情生成动态。 新架构只是把这些能力变成显式 flow。

---

# 十、包选择清单

第一阶段依赖：

```json
{
  "dependencies": {
    "next": "^16",
    "react": "^19",
    "react-dom": "^19",
    "ai": "^6",
    "@ai-sdk/openai": "latest",
    "@ai-sdk/anthropic": "latest",
    "@ai-sdk/google": "latest",
    "@ai-sdk/deepseek": "latest",
    "zod": "latest",
    "drizzle-orm": "latest",
    "better-sqlite3": "latest",
    "nanoid": "latest",
    "zustand": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "drizzle-kit": "latest",
    "@types/better-sqlite3": "latest",
    "vitest": "latest",
    "tsx": "latest"
  }
}
```

暂时不要：

```text
langchain
langgraph
mastra
qdrant-client
prisma
nestjs
bullmq
redis
postgres
```

理由：

LangChain / LangGraph / Mastra 都可以做 agent workflow，但对你这个阶段来说会把“角色聊天平台”变成“框架项目”。现在需要的是稳定产品内核，不是展示 agent framework 能力。

Hono 也不错，它是小型、简单、跨 runtime 的 TypeScript Web 框架，官方强调轻量、零依赖、多 runtime。([Hono][8]) 但因为你已经有 Next.js 前端，我建议先不用 Hono。除非你明确要把 API 独立成 standalone server。

---

# 十一、迁移路线

## Phase 0：冻结 Python 版本

在当前 main 上打 tag：

```bash
git checkout main
git tag python-mvp-freeze
git push origin python-mvp-freeze
```

新建分支：

```bash
git checkout -b refactor/typescript-lightflow
```

---

## Phase 1：建立 TypeScript 新骨架

保留 UI 视觉和主要组件，但删除 Python 后端依赖。

```bash
pnpm create next-app@latest .
pnpm add ai zod drizzle-orm better-sqlite3 nanoid zustand
pnpm add @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/deepseek
pnpm add -D drizzle-kit @types/better-sqlite3 vitest tsx
```

建立：

```text
src/server/db
src/server/ai
src/server/flow
src/server/domain
src/app/api
```

---

## Phase 2：SQLite schema + repository

先实现：

```text
AgentRepo
WorldRepo
ConversationRepo
MemoryRepo
FeedRepo
```

不要先做 UI。先用脚本验证：

```bash
pnpm tsx scripts/dev-seed.ts
pnpm tsx scripts/smoke-chat.ts
```

---

## Phase 3：ChatFlow 跑通

目标是替代当前 `/chat`：

```text
输入 message
→ 返回 reply + mood + recalledMemories
→ 写入 SQLite
→ 异步抽取记忆
```

这一阶段不做动态流、不做任务、不做复杂工具。

---

## Phase 4：迁移前端 API

把当前 `ui/src/lib/api/companion.ts` 的 HTTP 调用改成 `/api/*`。当前前端的 `streamChat()` 已经是自定义 SSE 读取逻辑。 可以先兼容这个协议，降低迁移成本。

---

## Phase 5：AgentCreateFlow + WorldFlow

实现：

```text
POST /api/agents
POST /api/agents/ai-create
GET /api/worlds
POST /api/worlds
```

把“世界域 + AI 建角”保留下来。

---

## Phase 6：FeedGenerateFlow

实现：

```text
GET /api/feed
POST /api/feed/generate
POST /api/feed/:id/trigger-chat
```

动态流是这个项目的产品差异点，不建议砍掉。

---

## Phase 7：工具层

只加低风险工具：

```text
searchMemories
createTaskDraft
createFeedPostDraft
```

不要做自动执行任务。

---

# 十二、环境变量设计

```env
# App
APP_ENV=development
DEV_USER_ID=u001

# Database
DATABASE_URL=file:./data/another-world.sqlite

# AI
AI_PROVIDER=deepseek
CHAT_MODEL=deepseek-chat
MEMORY_MODEL=deepseek-chat
AGENT_CREATOR_MODEL=deepseek-chat
WORLD_CREATOR_MODEL=deepseek-chat
FEED_MODEL=deepseek-chat

# Provider keys
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=

# Feature flags
ENABLE_MEMORY_ASYNC=true
ENABLE_FEED=true
ENABLE_TOOLS=false
ENABLE_AUTH=false
```

---

# 十三、架构边界原则

这次重构要坚持几个原则。

第一，**Flow 不能依赖 HTTP**。
`ChatFlow` 应该能被 API、测试脚本、未来桌面端、未来移动端复用。

第二，**LLM 不直接散落在业务代码里**。
所有模型调用只从 `server/ai` 走。

第三，**Repository 不知道 AI**。
数据层只负责保存和查询。

第四，**工具不是主链路**。
聊天主链路是稳定 workflow，工具只是可选增强。

第五，**默认本地轻量运行**。
不需要 Docker，不需要 Postgres，不需要 Qdrant。

---

# 十四、我建议你最终做成的产品内核

重构后的 AI_Another 应该变成：

> **一个轻量 TypeScript AI 角色引擎。**
> 支持创建角色、创建世界、长期聊天、记忆抽取、记忆召回、角色动态、受控工具扩展。

它不是 LangChain 项目，不是 pi-agent 项目，也不是 OpenRouter wrapper。它应该有自己的清晰内核：

```text
Role Engine
Memory Engine
World Engine
Flow Engine
LLM Provider Adapter
```

---

# 十五、最终决策

我的架构建议是：

```text
采用：
Next.js App Router
TypeScript
AI SDK
Zod
Drizzle
SQLite / better-sqlite3
自研轻量 Flow Runner

不采用：
Python FastAPI
OpenRouter 专用 client
Postgres 默认依赖
Qdrant 默认依赖
LangChain / Mastra / pi-agent 作为核心
```

这条路线最符合你说的“轻量化，但能力充足”。

它保留当前项目最有价值的东西：**多角色、世界观、长期记忆、动态流、情绪状态**。
同时删除当前最重的东西：**Python 后端、双服务、CORS、Postgres/Qdrant 强依赖、到处手写 JSON 修复、巨型 main.py**。

[1]: https://nextjs.org/docs/app/building-your-application/routing/route-handlers "File-system conventions: route.js | Next.js"
[2]: https://ai-sdk.dev/docs/introduction "AI SDK by Vercel"
[3]: https://ai-sdk.dev/docs/foundations/providers-and-models "Foundations: Providers and Models"
[4]: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data "AI SDK Core: Generating Structured Data"
[5]: https://orm.drizzle.team/docs/overview "Drizzle ORM - Why Drizzle?"
[6]: https://github.com/WiseLibs/better-sqlite3 "GitHub - WiseLibs/better-sqlite3: The fastest and simplest library for SQLite3 in Node.js. · GitHub"
[7]: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling "AI SDK Core: Tool Calling"
[8]: https://hono.dev/docs/ "Hono - Web framework built on Web Standards"
