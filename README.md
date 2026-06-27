# Another-World

个人 vibe-coding 项目。当前主线已经重构为 **Next.js + TypeScript + SQLite** 的轻量 AI 角色工作流平台。

## 当前能力

1. 多角色管理：手动创建、AI 本地生成、更新、软删除。
2. 多世界管理：手动创建/更新、AI 本地生成、按世界隔离角色和会话。
3. 聊天主链路：SSE 回复、安全检查、记忆召回、SQLite 会话持久化、异步记忆抽取任务。
4. 长期记忆：按 user/agent/world 范围管理，支持 active/frozen/deleted 状态，召回使用 SQLite FTS5 + 多因子评分。
5. 角色动态：AI structured-output 生成动态、列表读取、从动态注入聊天话题。
6. 低风险工具层：记忆搜索、任务草稿、动态草稿，默认关闭。

## 技术栈

1. App：Next.js App Router、React、TypeScript、Tailwind CSS。
2. AI：Vercel AI SDK provider 抽象，默认可用本地 mock。
3. 数据：SQLite + better-sqlite3 + Drizzle schema。
4. 工作流：自研轻量 Flow Runner，显式拆分 ChatFlow、AgentCreateFlow、WorldFlow、FeedGenerateFlow。

默认不需要 FastAPI、Postgres、Qdrant、Docker 或 CORS 双服务。

## 目录结构

```text
ui/
  src/app/api/              Next.js Route Handlers
  src/features/             前端功能模块
  src/server/db/            SQLite 初始化与 schema
  src/server/ai/            模型选择与结构化输出
  src/server/domain/        Repository 与业务记录类型
  src/server/flow/          轻量工作流
  src/server/tools/         低风险工具注册
```

## 本地启动

```bash
cd ui
npm install
npm run dev
```

开发服务器默认运行在 `http://localhost:3000`，UI 和 API 都在同一个 Next.js 应用内。

## 环境变量

在 `ui/.env.local` 配置：

```env
DATABASE_URL=file:./data/another-world.sqlite
NEXT_PUBLIC_DEMO_USER_ID=u001

# 默认 mock 可本地运行；配置真实 provider 后可切换。
AI_PROVIDER=mock
CHAT_MODEL=
MEMORY_MODEL=
AGENT_CREATOR_MODEL=
WORLD_CREATOR_MODEL=
FEED_MODEL=

DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
MINIMAX_API_KEY=
MINIMAX_BASE_URL=

ENABLE_MEMORY_ASYNC=true
ENABLE_FEED=true
ENABLE_TOOLS=false
ENABLE_AUTH=false
```

`AI_PROVIDER=mock` 是默认的确定性本地模式，不需要外部网络或 API key。切换真实 provider 后，聊天、记忆抽取、角色创建、世界创建和动态生成分别读取对应的 `*_MODEL` 环境变量；未设置时回退到 `CHAT_MODEL`。

## 本地 Embedding 服务

长期记忆合并可以使用本地 llama.cpp embedding server。默认地址是 `http://127.0.0.1:8080/v1`。

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

相关环境变量：

```env
LLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
LLAMA_EMBEDDING_MODEL=bge-m3
LLAMA_EMBEDDING_TIMEOUT_MS=5000
EMBEDDING_FALLBACK_DIMENSION=128
EMBEDDING_ALLOW_FALLBACK_SEMANTIC_MERGE=false
```

如果服务未启动，系统会写入 fallback embedding 并标记需要刷新；fallback 不参与默认语义合并。

## 常用命令

```bash
cd ui
npm run test:run
npm run lint
npm run build
npm run dev:seed
npm run smoke:chat
```

## 主要 API

所有接口都挂在同源 `/api` 下。

### 聊天与会话

1. `POST /api/chat`：SSE 聊天。
2. `GET /api/conversations`：读取历史会话。

### 角色

1. `GET /api/agents`
2. `POST /api/agents`
3. `POST /api/agents/ai-create`
4. `GET /api/agents/{agentId}`
5. `PUT /api/agents/{agentId}`
6. `DELETE /api/agents/{agentId}`
7. `GET /api/agents/{agentId}/state/live`
8. `POST /api/agents/{agentId}/memory-seed/debug`

### 世界

1. `GET /api/worlds`
2. `POST /api/worlds`
3. `GET /api/worlds/{worldId}`
4. `PUT /api/worlds/{worldId}`
5. `POST /api/worlds/ai-create`

### 记忆

1. `GET /api/memories`
2. `POST /api/memories/{memoryId}/freeze`
3. `POST /api/memories/{memoryId}/activate`
4. `DELETE /api/memories/{memoryId}`

### 动态

1. `GET /api/posts`
2. `POST /api/agents/{agentId}/generate-post`
3. `POST /api/posts/{postId}/trigger-chat`

## 持久化

默认 SQLite 文件位于 `ui/data/another-world.sqlite`。初始化会自动创建 worlds、agents、conversations、messages、memories、memories_fts、agent_live_states、feed_posts、tasks 等表，并写入默认世界和默认角色。

Drizzle schema 位于 `ui/src/server/db/schema.ts`，配置文件是 `ui/drizzle.config.ts`。当前运行时仍由 `getDatabase()` 懒初始化 SQLite 表结构，`npm run db:generate` 用于生成后续迁移文件。

## 界面展示

![UI](figures/UI_v0.2.jpg)
