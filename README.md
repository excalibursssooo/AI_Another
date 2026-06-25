# Another-World

个人 vibe-coding 项目。当前主线已经重构为 **Next.js + TypeScript + SQLite** 的轻量 AI 角色工作流平台。

## 当前能力

1. 多角色管理：手动创建、AI 本地生成、更新、软删除。
2. 多世界管理：手动创建/更新、AI 本地生成、按世界隔离角色和会话。
3. 聊天主链路：SSE 回复、安全检查、记忆召回、SQLite 会话持久化、异步记忆抽取。
4. 长期记忆：按 user/agent/world 范围管理，支持 active/frozen/deleted 状态。
5. 角色动态：生成动态、列表读取、从动态注入聊天话题。
6. 低风险工具层：记忆搜索、任务草稿、动态草稿。

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

DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
```

## 常用命令

```bash
cd ui
npm run test:run
npm run lint
npm run build
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

默认 SQLite 文件位于 `ui/data/another-world.sqlite`。初始化会自动创建 worlds、agents、conversations、messages、memories、agent_live_states、feed_posts 等表，并写入默认世界和默认角色。

## 界面展示

![UI](figures/UI_v0.2.jpg)
