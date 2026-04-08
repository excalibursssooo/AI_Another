这是对 `chat-app.tsx` 的修改意见
### 🚨 1. 关键疏漏：悬空的 Ref 导致动画失效 (The Bad)

在上次重构建议中，为了阻断高频渲染，建议将 `useLiveState` 改造为通过 `useRef` + `requestAnimationFrame` 直接驱动 DOM。

**问题所在**：
在当前的 `chat-app.tsx` 中，你调用了该 Hook：
```tsx
useLiveState({ userId: USER_ID, selectedAgent });
```
**但是你完全忽略了它的返回值！** 如果 `useLiveState` 已经被重构为返回一个 `vitalsContainerRef`，你**必须**将这个 Ref 绑定到 UI 树上的某个 DOM 节点，否则 CSS 变量或内部文本将无法被更新，心跳抖动动画会直接“罢工”。

**修改方案**：
如果你把状态面板做在了 `ChatSidebar` 或者主界面顶部，请将 Ref 传递给对应的容器：
```tsx
// 1. 获取 Ref
const { vitalsContainerRef } = useLiveState({ userId: USER_ID, selectedAgent });

// 2. 绑定到对应的 UI 容器 (例如传递给 Sidebar)
<ChatSidebar 
  vitalsRef={vitalsContainerRef} // 传递并在内部绑定到 <div ref={vitalsRef}>
  // ...other props
/>
```

### 🛠️ 2. 代码洁癖与细节优化 (Nitpicks)

1. **心跳遥感的 Hardcode 会话 ID**：
   ```tsx
   sendHeartbeat({ session_id: "demo-session", page: "chat", mode: APP_MODE });
   ```
   这里的 `session_id` 写死了 `"demo-session"`。在后端统计 Web Vitals 时，这会导致所有用户的数据全部聚合在同一个 Session 之下，无法进行用户追踪。建议在 `chat-app.tsx` 顶部使用 `useMemo` 生成一个生命周期唯一的 UUID：
   ```tsx
   const sessionId = useMemo(() => uid("sess"), []);
   ```

2. **环境变量容错冗余**：
   ```tsx
   const USER_ID = process.env.NEXT_PUBLIC_DEMO_USER_ID?.trim() || "u_demo_101";
   ```
   既然你在前序 API `client.ts` 改造中已经具备了“Fail Fast（快速失败）”思维，这里的核心凭证 `USER_ID` 也应该在生产环境下执行严格校验，而不是悄无声息地降级到 demo ID。
