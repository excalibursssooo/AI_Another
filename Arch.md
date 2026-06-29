下面给你一个**适合 AI_Another 当前阶段的整体框架**。核心原则是：**继续走 Next.js 单体全栈 + TypeScript Server Modules + SQLite/Drizzle + 自研 Flow Runner，不要切到 NestJS / Hono / tRPC / LangChain 这种重框架。**

你的项目文档本身已经定了正确方向：`ui/src/app/api` 做 HTTP/SSE，`ui/src/server/config/db/domain/ai/flow` 承载服务端能力，Route Handler 不放业务逻辑。 这也符合 Next.js 官方给出的“把应用代码放在 `app` 外部，`app` 只负责 routing”的组织方式。([Next.js][1])

---

# 推荐整体架构

```text
ui/
  src/
    app/
      api/
        chat/route.ts
        agents/route.ts
        agents/[agentId]/route.ts
        worlds/route.ts
        memories/route.ts
        posts/route.ts
        internal/tasks/drain/route.ts
      page.tsx
      layout.tsx

    server/
      api/
        request.ts
        response.ts
        errors.ts
        dto/
          agent-dto.ts
          world-dto.ts
          memory-dto.ts
          chat-dto.ts
        schemas/
          chat-request.schema.ts
          agent-request.schema.ts
          world-request.schema.ts
          memory-request.schema.ts

      config/
        env.ts
        feature-flags.ts
        model-config.ts

      db/
        client.ts
        schema.ts
        migrations/
        migrate.ts

      domain/
        agent/
          agent-record.ts
          agent-repository.ts
          agent-service.ts

        world/
          world-record.ts
          world-repository.ts
          world-service.ts

        conversation/
          conversation-record.ts
          conversation-repository.ts
          conversation-service.ts

        memory/
          memory-record.ts
          memory-repository.ts
          memory-consolidator.ts
          memory-scoring.ts
          memory-source-service.ts
          memory-operation-log-repository.ts

        feed/
          feed-post-record.ts
          feed-post-repository.ts
          feed-topic-repository.ts
          feed-service.ts

        live-state/
          agent-live-state-repository.ts
          live-state-service.ts

        task/
          task-record.ts
          task-repository.ts
          task-worker-service.ts

        world-mind/
          world-event-record.ts
          world-event-repository.ts
          world-state-repository.ts
          character-state-repository.ts
          actor-command-repository.ts
          world-decision-log-repository.ts
          world-reducer.ts
          world-replay-service.ts
          world-context-builder.ts
          world-decision-validator.ts

      ai/
        models.ts
        structured-output.ts
        schemas.ts
        prompts/
          chat-prompt.ts
          memory-prompt.ts
          agent-create-prompt.ts
          world-create-prompt.ts
          feed-prompt.ts
          world-director-prompt.ts
        generators/
          generate-chat-reply.ts
          generate-memory-extraction.ts
          generate-agent-draft.ts
          generate-world-draft.ts
          generate-feed-post.ts
          generate-world-decision.ts
        embeddings.ts

      flow/
        runner.ts
        types.ts
        chat-flow.ts
        memory-extract-flow.ts
        agent-create-flow.ts
        world-create-flow.ts
        feed-generate-flow.ts
        world-interaction-flow.ts
        world-mind-flow.ts

      tools/
        registry.ts
        low-risk-actions.ts
        tool-policy.ts

      workers/
        memory-worker.ts
        feed-worker.ts
        world-tick-worker.ts
        task-drain-worker.ts

      observability/
        operation-log.ts
        ai-log.ts
        flow-log.ts

    features/
      chat/
        components/
        hooks/
          useSendMessage.ts
          useAgents.ts
          useLiveState.ts
          useFeedActions.ts
          useAgentCreation.ts
          useTelemetry.ts
        types.ts

      world/
        components/
        hooks/

      memory/
        components/
        hooks/

    lib/
      api/
        client.ts
        companion.ts
        types_api.ts

    stores/
      useChatStore.ts
      useWorldStore.ts

    config/
      constants.ts
```

这个结构的重点不是“目录多”，而是**每层只做一类事情**。

---

# 分层边界

## 1. `app/api`：只做 HTTP / SSE

Next.js 官方 Route Handler 就是基于 Web `Request` / `Response` API 的自定义请求处理入口，并支持 `GET/POST/PUT/PATCH/DELETE` 等方法。([Next.js][2]) 所以你的 `route.ts` 应该只做：

```text
1. parse request
2. Zod validate
3. get user context
4. call flow/service
5. return Response / SSE
```

不要在 `route.ts` 里：

```text
- new 多个 repository
- 拼 prompt
- 写复杂业务判断
- drain 后台任务
- 直接处理 memory/worker 副作用
```

你当前 `/api/chat/route.ts` 已经有一点越界：它在 SSE 请求结束后直接 `drainChatTasks({ db })`。 这个应该移到 `workers/` 或 `internal/tasks/drain`。

---

## 2. `server/api`：DTO、请求校验、错误格式

现在很多 route 直接：

```ts
const body = (await req.json()) as SomeType;
```

例如 `/api/chat` 是直接强转 body。 `/api/agents`、`/api/worlds` 也类似。

推荐统一改成：

```ts
// server/api/request.ts
export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const raw = await req.json().catch(() => {
    throw new ApiError(400, "invalid_json");
  });

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_request", parsed.error.flatten());
  }

  return parsed.data;
}
```

所有 route 只写：

```ts
const body = await parseJsonBody(req, ChatRequestSchema);
```

这样就不会到处出现 `as` 强转。

---

## 3. `domain/*`：业务实体与 repository，不碰 AI

你现在最大的问题之一是 `domain/chat/repositories.ts` 已经变成 God File。它同时放了 Agent、World、Conversation、Memory、LiveState、FeedPost 的 record、row、mapper、repository、scoring。

推荐把它拆成多个领域目录：

```text
domain/agent
domain/world
domain/conversation
domain/memory
domain/feed
domain/live-state
domain/task
domain/world-mind
```

Repository 规则：

```text
Repository 可以：
- 读写数据库
- 做 row <-> record 映射
- 封装 SQL 查询
- 保证单表/少量表的数据一致性

Repository 不可以：
- 调 AI
- 拼 prompt
- 读取 process.env
- 处理前端 DTO
- 做复杂 Flow 编排
```

例如 `MemoryRepository` 只负责 memory 表，不应该和 feed、agent、world 混在同一个文件。

---

## 4. `flow/*`：显式工作流编排

你现有 `Flow` runner 很轻，只负责按顺序运行节点和发出 node lifecycle event。 这个方向是对的。

推荐保留这种轻量 Flow，不要引入 LangChain/Mastra。AI_Another 更需要的是**可审计、可测试、可回放的业务流**，不是通用 agent 框架。

每个 Flow 的规则：

```text
Flow 可以：
- 串联步骤
- 调 domain service / repository
- 调 ai generator
- 构造上下文
- 决定跳过/继续/失败

Flow 不可以：
- 直接读取 process.env
- 直接写 HTTP Response
- 直接返回前端 DTO
- 直接变成超大函数
```

你当前 `ChatFlow` 已经包含安全检查、prompt 构造、工具开关、模型调用、持久化、live state、memory task 入队、done event 构造。 建议把它拆成：

```text
flow/chat-flow.ts
domain/chat/chat-prompt-builder.ts
domain/chat/chat-safety.ts
domain/chat/chat-finalizer.ts
tools/tool-policy.ts
```

---

## 5. `ai/*`：模型、Prompt、结构化输出

AI SDK 官方明确建议对结构化输出使用 schema，并且要校验，因为 LLM 可能输出不正确或不完整的数据；AI SDK 支持用 Zod/JSON Schema 约束输出结构。([AI SDK][3])

你的项目已经在用 `ChatReplySchema`、`MemoryExtractionSchema`、`AgentDraftSchema`、`WorldDraftSchema`。 方向正确。

推荐 `ai/` 层拆成：

```text
ai/
  models.ts
  structured-output.ts
  schemas.ts
  prompts/
  generators/
```

并规定：

```text
ai/generators 只返回结构化结果，不写数据库
ai/prompts 只拼 prompt，不读取 repository
ai/models 只处理 provider/model 选择
ai/structured-output 只处理 schema + generateText/streamText
```

你当前 `ai/chat.ts` 同时包含 chat、agent draft、world draft、memory extraction、feed post、streaming 等多个 generator。   可以拆成多个文件。

---

## 6. `tools/*`：低风险工具层，默认只读或 draft

AI SDK 工具调用支持 `inputSchema`，工具调用和工具结果也可以有类型推断。([AI SDK][4]) 你现在的工具层比较克制：`searchMemories`、`createTaskDraft`、`createFeedPostDraft` 都是低风险工具。

这很好。建议继续坚持：

```text
MVP 阶段：
- searchMemories：允许
- createTaskDraft：只 draft，不执行
- createFeedPostDraft：只 draft，不发布

禁止：
- LLM 直接写数据库
- LLM 直接删除/修改角色
- LLM 直接推进世界状态
```

未来 WorldMind 也应遵循你设计里的原则：**LLM proposes，Validator accepts/rejects，事务提交，Reducer 派生状态**。你的 WorldMind 文档已经明确了这条规则。

---

# 数据层框架

## 推荐：Drizzle schema + migrations 做唯一事实来源

Drizzle 官方迁移文档强调，SQL 数据库需要预先定义严格 schema，schema 变化需要通过 migrations 管理。([orm.drizzle.team][5])

你当前的问题是：`schema.ts` 里有一份 Drizzle schema，`client.ts` 里又有一大份 raw SQL `CREATE TABLE IF NOT EXISTS`。  这会造成“双重真相”。

推荐最终状态：

```text
db/schema.ts          唯一 schema 定义
db/migrations/*.sql   schema 变更历史
db/client.ts          只负责连接、pragma、执行 migrate、seed
```

`client.ts` 不再手写完整建表 SQL，只保留：

```ts
export function getDatabase(): AppDatabase {
  const sqlite = new Database(resolveDatabasePath());
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  runMigrations(sqlite);
  seedDefaults(sqlite);

  return { sqlite, orm: drizzle(sqlite, { schema }) };
}
```

短期如果你不想立刻上 drizzle-kit，也至少要做到：

```text
schema.sql / migrations.sql 是唯一建表来源
schema.ts 只跟随它，不再手动分叉
```

---

# WorldMind 应该放在哪一层

WorldMind 不应该塞进现有 `domain/chat`，应该独立：

```text
server/domain/world-mind/
server/flow/world-mind-flow.ts
server/flow/world-interaction-flow.ts
server/workers/world-tick-worker.ts
```

推荐边界：

```text
world-interaction-flow
  处理用户输入、安全检查、client_action_id、创建 world run envelope

world-mind-flow
  LoadWorldRuntime
  LoadWorldStateSnapshot
  LoadActiveActors
  LoadRecentEventLedger
  RecallWorldMemory
  BuildDirectorContext
  GenerateDirectorDecision
  ValidateDirectorDecision
  CommitWorldRunTransaction
  ConsolidateWorldMemorySecondary
  ScheduleNextTickSecondary

domain/world-mind
  event ledger
  reducer
  validator
  replay
  visibility ACL
  actor commands
```

不要让 ChatFlow 直接变成 WorldMind。ChatFlow 是“角色回复”，WorldMind 是“世界状态推进”。两者应该通过 **visible actor directive** 连接。

你的 WorldMind 设计里也强调：`world_events` 是状态源，命令不是事实，命令执行结果必须回报为新事件，replay 顺序基于 `sequence` 而不是 `created_at`。 这些规则应该落成独立模块，不要混进 chat repository。

---

# 前端框架

前端继续使用：

```text
features/
  chat/
  world/
  memory/
stores/
lib/api/
```

但 `ChatApp` 要继续瘦身。它现在同时处理角色创建、AI 建角、聊天发送、SSE 拼接、live state、feed、telemetry、theme、world manager 等。

推荐拆成：

```text
features/chat/hooks/useSendMessage.ts
features/chat/hooks/useAgentCreation.ts
features/chat/hooks/useFeedActions.ts
features/chat/hooks/useTelemetry.ts
features/chat/hooks/useChatSelection.ts
```

`ChatApp` 最终只保留：

```text
布局
状态组合
组件装配
```

不要再承载具体业务流程。

---

# 代码规范建议

## TypeScript

使用：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true
}
```

配合 `typescript-eslint` typed linting。typescript-eslint 官方说明，typed linting 会调用 TypeScript 类型检查 API，能提供比普通 lint 更深入的静态分析，但会更慢；官方仍强烈推荐使用 type-aware linting。([TypeScript ESLint][6])

## 文件规范

建议约束：

```text
route.ts                         <= 80 行
repository.ts                    <= 250 行
flow.ts                          <= 220 行
React component                  <= 250 行
hook                             <= 180 行
schema/dto/mapper                可以更短
```

超过就拆。

## 命名规范

```text
数据库列：snake_case
服务端 record：camelCase
API DTO：snake_case，兼容现有前端
React props/state：camelCase
Flow node：PascalCase，如 LoadAgent / GenerateReply
Repository method：动词开头，如 get / list / create / update / deactivate
```

## 依赖方向

强制保持：

```text
app/api
  -> server/api
  -> server/flow
  -> server/domain
  -> server/db

server/flow
  -> server/ai
  -> server/domain

server/domain
  -> server/db

server/ai
  -> AI SDK / providers
  不允许依赖 db

features
  -> lib/api
  -> stores
  不允许 import server/*
```

最重要的是：**domain 不依赖 ai，ai 不依赖 db，route 不写业务，frontend 不碰 server。**

---

# 最终结论

AI_Another 当前最合适的整体框架是：

```text
Next.js App Router 单体全栈
+ Route Handler 薄 HTTP 层
+ server/api 统一 DTO/Zod/Error
+ server/flow 显式 AI 工作流
+ server/domain 分领域 Repository/Service
+ server/ai 结构化输出与模型适配
+ Drizzle migrations 作为唯一 schema 来源
+ workers 独立处理 memory/feed/world tick
+ frontend features/hooks/stores 分离
```

不要现在引入 NestJS、Hono、tRPC、LangChain、Mastra。你真正需要的不是更多框架，而是**更严格的边界、可审计事件账本、可靠任务队列、可维护的 Flow 分层**。

[1]: https://nextjs.org/docs/app/getting-started/project-structure "Getting Started: Project Structure | Next.js"
[2]: https://nextjs.org/docs/app/api-reference/file-conventions/route "File-system conventions: route.js | Next.js"
[3]: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data "AI SDK Core: Generating Structured Data"
[4]: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling "AI SDK Core: Tool Calling"
[5]: https://orm.drizzle.team/docs/migrations "Drizzle ORM - Migrations"
[6]: https://typescript-eslint.io/getting-started/typed-linting/ "Linting with Type Information | typescript-eslint"
