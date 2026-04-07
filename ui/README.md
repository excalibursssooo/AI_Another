# Companion Chat Frontend

这是 `AI_Another` 项目的前端实现（Next.js + TypeScript + Tailwind）。

## 当前能力

1. 温暖陪伴感三栏聊天界面（AI 联系人、聊天区、右侧管理面板）。
2. 联系人切换与流式消息渲染。
3. 角色管理（创建、AI 建角、删除）。
4. 记忆管理（列表、冻结/激活、删除）。
5. 支持 `Mock` / `真实后端` 双模式切换。

## 启动方式

```bash
npm install
npm run dev
```

默认地址：`http://localhost:3000`

## 环境变量

在 `ui` 目录下创建 `.env.local`：

```env
# true: 使用本地 mock 数据（默认）
# false: 连接真实后端
NEXT_PUBLIC_USE_MOCK=true

# 真实后端地址（当 NEXT_PUBLIC_USE_MOCK=false 时生效）
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000

# 前端演示用户ID
NEXT_PUBLIC_DEMO_USER_ID=u001
```

## Mock 与真实后端

1. `Mock 模式`：可独立演示前端交互，不依赖后端。
2. `真实后端模式`：
	- 聊天通过 `/chat` SSE 流式返回 `delta/done`。
	- 联系人使用 `/agents` 与 `/agents/ai-create`。
	- 记忆使用 `/memories` 与 `freeze/activate/delete`。

## 脚本

```bash
npm run dev
npm run lint
npm run build
```
