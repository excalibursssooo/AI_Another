"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  activateMemory,
  createAgent,
  createAgentByAi,
  deleteAgent as deleteAgentRequest,
  listConversationTurns,
  deleteMemory,
  freezeMemory,
  listAgents,
  listMemories,
  streamChat,
} from "@/lib/api/companion";
import { AgentResponseDto, MemoryResponseDto } from "@/lib/api/types";
import { reportFrontendError, reportWebVital, sendHeartbeat } from "@/lib/api/telemetry";
import { seedAgents, seedMemories, seedMessages } from "@/lib/mock/seed";
import { AiAgent, ChatMessage, MemoryRecord, MemoryStatus } from "@/features/chat/types";

type PanelTab = "memories" | "agents";
const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK !== "false";
const USER_ID = process.env.NEXT_PUBLIC_DEMO_USER_ID?.trim() || "u001";
const APP_MODE = USE_MOCK ? "mock" : "live";

const AGENT_COLORS = ["var(--agent-amber)", "var(--agent-coral)", "var(--agent-teal)", "var(--agent-rose)"];

function nowTime(): string {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatTimeFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nowTime();
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function mapAgentFromApi(item: AgentResponseDto, index: number): AiAgent {
  return {
    id: item.id,
    name: item.display_name || item.name,
    persona: item.persona,
    background: item.background,
    hobbies: item.hobbies,
    speakingStyle: item.speaking_style,
    status: item.status,
    tagline: item.persona.slice(0, 28),
    avatarColor: AGENT_COLORS[index % AGENT_COLORS.length],
  };
}

function mapMemoryFromApi(item: MemoryResponseDto): MemoryRecord {
  return {
    id: item.id,
    agentId: item.agent_id,
    memoryType: item.memory_type as MemoryRecord["memoryType"],
    content: item.content,
    confidence: item.confidence,
    importance: item.importance,
    status: item.status,
    createdAt: item.created_at,
  };
}

function buildAssistantReply(agent: AiAgent, text: string): string {
  if (!text.trim()) {
    return "我在，慢慢来。你先说一句最想被理解的话。";
  }

  return `我听到了你说“${text.trim()}”。以${agent.name}的方式，我建议先做一个最小动作：把这件事拆成今天可以完成的第一步。你不用一次解决全部，我会陪你走完。`;
}

export function ChatApp() {
  const [agents, setAgents] = useState<AiAgent[]>(seedAgents);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(seedAgents[0].id);
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>(seedMessages);
  const [memories, setMemories] = useState<MemoryRecord[]>(seedMemories);
  const [input, setInput] = useState<string>("");
  const [activeTab, setActiveTab] = useState<PanelTab>("memories");
  const [isSending, setIsSending] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>(USE_MOCK ? "当前为 Mock 模式" : "正在连接后端...");

  const [draftName, setDraftName] = useState<string>("");
  const [draftPersona, setDraftPersona] = useState<string>("");
  const [draftStyle, setDraftStyle] = useState<string>("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string>(uid("session"));

  const loadMemories = useCallback(async (agentId: string) => {
    if (USE_MOCK) {
      return;
    }

    try {
      const rows = await listMemories(USER_ID, agentId, "all");
      const mapped = rows.map(mapMemoryFromApi);
      setMemories((prev) => {
        const others = prev.filter((item) => item.agentId !== agentId);
        return [...others, ...mapped];
      });
    } catch (error) {
      setNotice(`记忆加载失败: ${(error as Error).message}`);
    }
  }, []);

  const loadConversation = useCallback(async (agentId: string, agentName: string) => {
    if (USE_MOCK) {
      return;
    }

    try {
      const rows = await listConversationTurns(USER_ID, agentId, 120);
      if (!rows.length) {
        setMessagesByAgent((prev) => {
          if ((prev[agentId] ?? []).length > 0) {
            return prev;
          }
          return {
            ...prev,
            [agentId]: [
              {
                id: uid("msg"),
                role: "assistant",
                content: `你好，我是${agentName}。我们从你现在最在意的一件事开始。`,
                createdAt: nowTime(),
              },
            ],
          };
        });
        return;
      }

      setMessagesByAgent((prev) => ({
        ...prev,
        [agentId]: rows.map((item, index) => ({
          id: `${agentId}-${index}-${item.created_at}`,
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.content,
          createdAt: formatTimeFromIso(item.created_at),
        })),
      }));
    } catch (error) {
      setNotice(`历史消息加载失败: ${(error as Error).message}`);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    if (USE_MOCK) {
      return;
    }

    try {
      const rows = await listAgents(true);
      const mapped = rows.map(mapAgentFromApi).filter((item) => item.status === "active");
      if (!mapped.length) {
        setNotice("未获取到可用 AI 联系人，已回退到 Mock 数据");
        return;
      }

      setAgents(mapped);
      setSelectedAgentId((prev) => (mapped.some((item) => item.id === prev) ? prev : mapped[0].id));
      setMessagesByAgent((prev) => {
        const next = { ...prev };
        for (const agent of mapped) {
          if (!next[agent.id]) {
            next[agent.id] = [
              {
                id: uid("msg"),
                role: "assistant",
                content: `你好，我是${agent.name}`,
                createdAt: nowTime(),
              },
            ];
          }
        }
        return next;
      });
      setNotice("已连接真实后端");
    } catch (error) {
      setNotice(`后端连接失败，继续使用本地数据: ${(error as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadMemories(selectedAgentId);
  }, [selectedAgentId, loadMemories]);

  useEffect(() => {
    if (USE_MOCK) {
      return;
    }
    const agent = agents.find((item) => item.id === selectedAgentId);
    if (!agent) {
      return;
    }
    void loadConversation(agent.id, agent.name);
  }, [agents, selectedAgentId, loadConversation]);

  useEffect(() => {
    if (USE_MOCK) {
      return;
    }

    const page = window.location.pathname;
    const send = () =>
      void sendHeartbeat({
        session_id: sessionIdRef.current,
        page,
        mode: APP_MODE,
        user_id: USER_ID,
      });

    send();
    const heartbeatTimer = setInterval(send, 45_000);
    return () => clearInterval(heartbeatTimer);
  }, []);

  useEffect(() => {
    if (USE_MOCK) {
      return;
    }

    const page = window.location.pathname;
    const onError = (event: ErrorEvent) => {
      void reportFrontendError({
        message: event.message || "unknown window error",
        page,
        source: event.filename || "window.onerror",
        stack: event.error instanceof Error ? event.error.stack : undefined,
        user_id: USER_ID,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      let message = "unhandled rejection";
      let stack: string | undefined;

      if (reason instanceof Error) {
        message = reason.message;
        stack = reason.stack;
      } else if (typeof reason === "string") {
        message = reason;
      } else {
        message = JSON.stringify(reason);
      }

      void reportFrontendError({
        message,
        page,
        source: "unhandledrejection",
        stack,
        user_id: USER_ID,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (USE_MOCK) {
      return;
    }

    const page = window.location.pathname;
    const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const value = navEntry ? navEntry.loadEventEnd - navEntry.startTime : performance.now();

    void reportWebVital({
      name: "page_load_ms",
      value,
      page,
      metric_id: sessionIdRef.current,
      rating: value > 3_000 ? "poor" : value > 1_500 ? "needs-improvement" : "good",
    });
  }, []);

  const selectedAgent = useMemo(
    () => agents.find((item) => item.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );

  const visibleMessages = messagesByAgent[selectedAgentId] ?? [];
  const visibleMemories = memories.filter((item) => item.agentId === selectedAgentId && item.status !== "deleted");

  const setMemoryStatus = async (id: string, status: MemoryStatus) => {
    const memory = memories.find((item) => item.id === id);
    if (!memory) {
      return;
    }

    if (USE_MOCK) {
      setMemories((prev) => prev.map((item) => (item.id === id ? { ...item, status } : item)));
      return;
    }

    try {
      if (status === "deleted") {
        await deleteMemory(id, { user_id: USER_ID, agent_id: memory.agentId });
      } else if (status === "frozen") {
        await freezeMemory(id, { user_id: USER_ID, agent_id: memory.agentId });
      } else {
        await activateMemory(id, { user_id: USER_ID, agent_id: memory.agentId });
      }
      await loadMemories(memory.agentId);
    } catch (error) {
      setNotice(`记忆操作失败: ${(error as Error).message}`);
    }
  };

  const createAgentHandle = async (event: FormEvent) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) {
      return;
    }

    if (!USE_MOCK) {
      try {
        const created = await createAgent({
          name,
          persona: draftPersona.trim() || "温暖、稳定、会倾听",
          background: "由你在前端创建的 AI 联系人。",
          hobbies: ["散步", "音乐"],
          speaking_style: draftStyle.trim() || "温柔有边界",
        });
        const mapped = mapAgentFromApi(created, agents.length);
        setAgents((prev) => [mapped, ...prev]);
        setSelectedAgentId(mapped.id);
        setDraftName("");
        setDraftPersona("");
        setDraftStyle("");
        setNotice("角色创建成功");
        return;
      } catch (error) {
        setNotice(`角色创建失败: ${(error as Error).message}`);
        return;
      }
    }

    const newAgent: AiAgent = {
      id: uid("agent"),
      name,
      persona: draftPersona.trim() || "温暖、稳定、会倾听",
      background: "由你亲手创建的专属 AI 联系人。",
      hobbies: ["散步", "音乐"],
      speakingStyle: draftStyle.trim() || "温柔有边界",
      status: "active",
      tagline: "陪你把今天过得更轻一点",
      avatarColor: "var(--agent-rose)",
    };

    setAgents((prev) => [newAgent, ...prev]);
    setMessagesByAgent((prev) => ({
      ...prev,
      [newAgent.id]: [
        {
          id: uid("msg"),
          role: "assistant",
          content: `你好，我是${newAgent.name}。`,
          createdAt: nowTime(),
        },
      ],
    }));
    setSelectedAgentId(newAgent.id);
    setDraftName("");
    setDraftPersona("");
    setDraftStyle("");
  };

  const aiCreateAgentHandle = async () => {
    if (!USE_MOCK) {
      try {
        const created = await createAgentByAi();
        const mapped = mapAgentFromApi(created.agent, agents.length);
        setAgents((prev) => [mapped, ...prev]);
        setSelectedAgentId(mapped.id);
        setNotice(`AI 建角成功（${created.model}）`);
        return;
      } catch (error) {
        setNotice(`AI 建角失败: ${(error as Error).message}`);
        return;
      }
    }

    const names = ["苏晚宁", "秦陌", "沈听澜", "程予安"];
    const idx = Math.floor(Math.random() * names.length);
    const generated: AiAgent = {
      id: uid("agent"),
      name: names[idx],
      persona: "敏感而理性，擅长在混乱里整理优先级",
      background: "模拟 AI 角色自动创建结果（mock）。",
      hobbies: ["摄影", "城市散步", "写作"],
      speakingStyle: "克制温和",
      status: "active",
      tagline: "把你的困惑变成可执行的节奏",
      avatarColor: "var(--agent-amber)",
    };

    setAgents((prev) => [generated, ...prev]);
    setMessagesByAgent((prev) => ({
      ...prev,
      [generated.id]: [
        {
          id: uid("msg"),
          role: "assistant",
          content: `我是${generated.name}。很高兴认识你，我们慢慢建立彼此的节奏。`,
          createdAt: nowTime(),
        },
      ],
    }));
    setSelectedAgentId(generated.id);
  };

  const deleteAgentHandle = async (agentId: string) => {
    if (agentId === "default") {
      return;
    }

    if (!USE_MOCK) {
      try {
        await deleteAgentRequest(agentId);
      } catch (error) {
        setNotice(`删除角色失败: ${(error as Error).message}`);
        return;
      }
    }

    setAgents((prev) => prev.filter((item) => item.id !== agentId));
    setSelectedAgentId((prev) => (prev === agentId ? "default" : prev));
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || !selectedAgent || isSending) {
      return;
    }

    setIsSending(true);

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const userMessage: ChatMessage = {
      id: uid("msg"),
      role: "user",
      content: text,
      createdAt: nowTime(),
    };

    const assistantMessageId = uid("msg");
    const fullReply = buildAssistantReply(selectedAgent, text);

    setMessagesByAgent((prev) => {
      const existing = prev[selectedAgentId] ?? [];
      return {
        ...prev,
        [selectedAgentId]: [
          ...existing,
          userMessage,
          {
            id: assistantMessageId,
            role: "assistant",
            content: "",
            createdAt: nowTime(),
            isStreaming: true,
          },
        ],
      };
    });

    setInput("");

    if (!USE_MOCK) {
      try {
        await streamChat(
          {
            user_id: USER_ID,
            message: text,
            conversation_id: selectedAgentId,
            agent_id: selectedAgentId,
          },
          {
            onDelta: (content) => {
              setMessagesByAgent((prev) => {
                const existing = prev[selectedAgentId] ?? [];
                const target = existing.find((msg) => msg.id === assistantMessageId);
                const nextContent = `${target?.content ?? ""}${content}`;
                return {
                  ...prev,
                  [selectedAgentId]: existing.map((msg) =>
                    msg.id === assistantMessageId ? { ...msg, content: nextContent, isStreaming: true } : msg,
                  ),
                };
              });
            },
            onDone: () => {
              setMessagesByAgent((prev) => {
                const existing = prev[selectedAgentId] ?? [];
                return {
                  ...prev,
                  [selectedAgentId]: existing.map((msg) =>
                    msg.id === assistantMessageId ? { ...msg, isStreaming: false } : msg,
                  ),
                };
              });
            },
          },
        );
        await loadMemories(selectedAgentId);
      } catch (error) {
        setMessagesByAgent((prev) => {
          const existing = prev[selectedAgentId] ?? [];
          return {
            ...prev,
            [selectedAgentId]: existing.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    content: `当前无法连接后端：${(error as Error).message}`,
                    isStreaming: false,
                  }
                : msg,
            ),
          };
        });
        setNotice("聊天已降级，请检查后端是否运行");
      } finally {
        setIsSending(false);
      }
      return;
    }

    let cursor = 0;
    timerRef.current = setInterval(() => {
      cursor += 4;
      const partial = fullReply.slice(0, cursor);
      const done = partial.length >= fullReply.length;

      setMessagesByAgent((prev) => {
        const existing = prev[selectedAgentId] ?? [];
        return {
          ...prev,
          [selectedAgentId]: existing.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, content: partial, isStreaming: !done } : msg,
          ),
        };
      });

      if (done && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setIsSending(false);
      }
    }, 30);
  };

  return (
    <div className="app-bg min-h-screen p-4 md:p-6">
      <div className="mx-auto grid h-[calc(100vh-2rem)] max-w-[1600px] grid-cols-1 overflow-hidden rounded-[30px] border border-[var(--line-soft)] bg-[var(--surface-main)] shadow-[var(--shadow-main)] backdrop-blur-sm lg:grid-cols-[320px_1fr_360px]">
        <aside className="panel-scroll flex min-h-0 flex-col border-b border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-r lg:border-b-0">
          <div className="px-5 pt-6 pb-4">
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">AI Contacts</p>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--text-main)]">陪伴联系人</h2>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
            {agents.map((agent) => {
              const active = agent.id === selectedAgentId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition-all duration-300 ${
                    active
                      ? "border-[var(--line-strong)] bg-[var(--surface-card)] shadow-[var(--shadow-neon)]"
                      : "border-transparent bg-transparent hover:border-[var(--line-soft)] hover:bg-[var(--surface-card)] hover:shadow-[var(--shadow-neon)]"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="h-9 w-9 rounded-full ring-1 ring-white/20"
                      style={{ backgroundColor: agent.avatarColor }}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--text-main)]">{agent.name}</p>
                      <p className="truncate text-xs text-[var(--text-muted)]">{agent.tagline}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="panel-scroll flex min-h-0 min-w-0 flex-col bg-[var(--surface-main)]/90">
          <header className="border-b border-[var(--line-soft)] px-5 py-4 md:px-8">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Current AI</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--text-main)]">{selectedAgent?.name}</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{selectedAgent?.persona}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{notice}</p>
          </header>

          <section className="flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-8">
            {visibleMessages.map((msg) => (
              <article
                key={msg.id}
                className={`max-w-[86%] rounded-2xl border px-4 py-3 text-sm leading-7 shadow-[0_8px_24px_rgba(7,10,31,0.45)] transition-all duration-300 ${
                  msg.role === "user"
                    ? "ml-auto border-fuchsia-300/30 bg-[var(--bubble-user)] text-[var(--bubble-user-text)]"
                    : "border-cyan-300/20 bg-[var(--bubble-ai)] text-[var(--text-main)] backdrop-blur-sm"
                }`}
              >
                <p>{msg.content || (msg.isStreaming ? "正在输入..." : "")}</p>
                <p className="mt-2 text-[11px] opacity-70">{msg.createdAt}</p>
              </article>
            ))}
          </section>

          <form onSubmit={sendMessage} className="border-t border-[var(--line-soft)] px-4 py-4 md:px-8">
            <div className="flex items-end gap-3 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)]/95 p-3 shadow-[var(--shadow-neon)] backdrop-blur-sm">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={2}
                placeholder="输入你想对 AI 说的话..."
                className="min-h-[60px] flex-1 resize-none bg-transparent text-sm text-[var(--text-main)] outline-none placeholder:text-[var(--text-muted)]"
              />
              <button
                type="submit"
                disabled={isSending}
                className="rounded-xl bg-[var(--brand-main)] px-4 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.03] hover:shadow-[0_0_28px_rgba(168,85,247,0.6)] disabled:opacity-70"
              >
                {isSending ? "发送中..." : "发送"}
              </button>
            </div>
          </form>
        </main>

        <aside className="panel-scroll flex min-h-0 flex-col border-t border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-t-0 lg:border-l">
          <div className="flex gap-2 border-b border-[var(--line-soft)] px-4 py-3">
            <button
              type="button"
              onClick={() => setActiveTab("memories")}
              className={`rounded-xl px-3 py-2 text-sm transition-all duration-300 ${
                activeTab === "memories"
                  ? "bg-[var(--surface-card)] text-[var(--text-main)] shadow-[var(--shadow-neon)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
              }`}
            >
              记忆管理
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("agents")}
              className={`rounded-xl px-3 py-2 text-sm transition-all duration-300 ${
                activeTab === "agents"
                  ? "bg-[var(--surface-card)] text-[var(--text-main)] shadow-[var(--shadow-neon)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
              }`}
            >
              角色管理
            </button>
          </div>

          {activeTab === "memories" ? (
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {visibleMemories.length === 0 ? (
                <p className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 text-sm text-[var(--text-muted)]">当前角色还没有记忆。</p>
              ) : (
                visibleMemories.map((item) => (
                  <section key={item.id} className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 shadow-[0_10px_24px_rgba(8,12,38,0.35)]">
                    <p className="text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">{item.memoryType}</p>
                    <p className="mt-2 text-sm text-[var(--text-main)]">{item.content}</p>
                    <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                      confidence {item.confidence.toFixed(2)} · importance {item.importance.toFixed(2)}
                    </p>
                    <div className="mt-3 flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => void setMemoryStatus(item.id, item.status === "frozen" ? "active" : "frozen")}
                        className="rounded-lg border border-[var(--line-soft)] px-2 py-1 text-[var(--text-main)] transition-all duration-300 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-neon)]"
                      >
                        {item.status === "frozen" ? "激活" : "冻结"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void setMemoryStatus(item.id, "deleted")}
                        className="rounded-lg border border-[var(--line-soft)] px-2 py-1 text-[var(--text-main)] transition-all duration-300 hover:border-fuchsia-400/70 hover:text-fuchsia-200"
                      >
                        删除
                      </button>
                    </div>
                  </section>
                ))
              )}
            </div>
          ) : (
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-2">
                {agents.map((agent) => (
                  <section key={agent.id} className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 shadow-[0_10px_24px_rgba(8,12,38,0.35)]">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-[var(--text-main)]">{agent.name}</p>
                      <button
                        type="button"
                        onClick={() => void deleteAgentHandle(agent.id)}
                        disabled={agent.id === "default"}
                        className="text-xs text-[var(--text-muted)] disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{agent.speakingStyle}</p>
                  </section>
                ))}
              </div>

              <form onSubmit={(event) => void createAgentHandle(event)} className="space-y-2 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 shadow-[var(--shadow-neon)]">
                <p className="text-sm font-semibold text-[var(--text-main)]">手动创建角色</p>
                <input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder="角色名字"
                  className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                />
                <input
                  value={draftPersona}
                  onChange={(event) => setDraftPersona(event.target.value)}
                  placeholder="角色性格"
                  className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                />
                <input
                  value={draftStyle}
                  onChange={(event) => setDraftStyle(event.target.value)}
                  placeholder="说话风格"
                  className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                />
                <button
                  type="submit"
                  className="w-full rounded-lg bg-[var(--brand-main)] px-3 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(217,70,239,0.45)]"
                >
                  创建
                </button>
                <button
                  type="button"
                  onClick={() => void aiCreateAgentHandle()}
                  className="w-full rounded-lg border border-[var(--line-soft)] px-3 py-2 text-sm text-[var(--text-main)] transition-all duration-300 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-neon)]"
                >
                  AI 自动生成
                </button>
              </form>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
