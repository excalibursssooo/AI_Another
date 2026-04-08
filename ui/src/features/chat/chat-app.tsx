"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  createAgent,
  createAgentByAi,
  deleteAgent,
  generatePost,
  listPosts,
  streamChat,
  triggerChatFromPost,
} from "@/lib/api/companion";
import { PostItemDto } from "@/lib/api/types_api";
import { reportFrontendError, reportWebVital, sendHeartbeat } from "@/lib/api/telemetry";
import { getErrorMessage } from "@/lib/utils/error";
import { ANIMATION_DELAYS, POLL_INTERVALS } from "@/config/constants";
import { AiAgent, ChatMessage } from "@/features/chat/types";
import { ChatArea } from "@/features/chat/components/ChatArea";
import { ChatSidebar } from "@/features/chat/components/ChatSidebar";
import { CreationOverlay } from "@/features/chat/components/CreationOverlay";
import { useAgents } from "@/features/chat/hooks/useAgents";
import { useCreationFlow } from "@/features/chat/hooks/useCreationFlow";
import { useFeedPolling } from "@/features/chat/hooks/useFeedPolling";
import { useLiveState } from "@/features/chat/hooks/useLiveState";
import { useWorldSettings } from "@/features/chat/hooks/useWorldSettings";
import { useChatStore } from "@/stores/useChatStore";
import { useWorldStore } from "@/stores/useWorldStore";

function getEnvUserId(): string {
  const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID?.trim();
  if (!userId && process.env.NODE_ENV === "production") {
    throw new Error("FATAL: NEXT_PUBLIC_DEMO_USER_ID is not defined in production environment.");
  }
  return userId || "u001";
}

const USER_ID = getEnvUserId();
const APP_MODE = "live";
const AGENT_COLORS = ["var(--agent-amber)", "var(--agent-coral)", "var(--agent-teal)", "var(--agent-rose)"];
const EMPTY_MESSAGES: ChatMessage[] = [];

type CreationPhase = "idle" | "parsing" | "restructuring" | "memory" | "diagnose" | "complete" | "error";

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

function formatAgo(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) {
    return "刚刚";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) {
    return `${seconds}秒前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}

function moodText(label: string): string {
  const map: Record<string, string> = {
    calm: "平静",
    happy: "愉悦",
    sad: "低落",
    anxious: "焦虑",
    angry: "激动",
    focused: "专注",
    neutral: "稳定",
  };
  return map[label] ?? label;
}

function mapAgentFromApi(item: {
  id: string;
  name: string;
  display_name: string;
  greeting: string;
  persona: string;
  background: string;
  domain_id: string;
  world_context: string;
  hobbies: ReadonlyArray<string>;
  speaking_style: string;
  status: "active" | "inactive";
}, index: number): AiAgent {
  return {
    id: item.id,
    name: item.display_name || item.name,
    greeting: item.greeting,
    persona: item.persona,
    background: item.background,
    domainId: item.domain_id,
    worldContext: item.world_context,
    hobbies: item.hobbies,
    speakingStyle: item.speaking_style,
    status: item.status,
    tagline: item.persona.slice(0, 28),
    avatarColor: AGENT_COLORS[index % AGENT_COLORS.length],
  };
}

function creationLabel(phase: CreationPhase): string {
  const map: Record<CreationPhase, string> = {
    idle: "待机",
    parsing: "解析阶段",
    restructuring: "重组阶段",
    memory: "记忆灌注",
    diagnose: "诊断阶段",
    complete: "定型完成",
    error: "构建失败",
  };
  return map[phase];
}

export function ChatApp() {
  const [fatalError, setFatalError] = useState<string>("");
  const [mounted, setMounted] = useState<boolean>(false);
  const [rightPanelTab, setRightPanelTab] = useState<"state" | "feed">("state");
  const [feedPosts, setFeedPosts] = useState<PostItemDto[]>([]);
  const [feedLoading, setFeedLoading] = useState<boolean>(false);
  const [isGeneratingPost, setIsGeneratingPost] = useState<boolean>(false);
  const [showAddFriendMenu, setShowAddFriendMenu] = useState<boolean>(false);
  const [showCustomCreateForm, setShowCustomCreateForm] = useState<boolean>(false);
  const [draftName, setDraftName] = useState<string>("");
  const [draftPersona, setDraftPersona] = useState<string>("");
  const [draftStyle, setDraftStyle] = useState<string>("");
  const [creatingPlaceholder, setCreatingPlaceholder] = useState<{ active: boolean; name: string }>({
    active: false,
    name: "角色构建中...",
  });
  const [isSending, setIsSending] = useState<boolean>(false);
  const sessionId = useMemo(() => uid("session"), []);
  const { overlay, startFlow, setRestructuringPhase, runSeedAndInfraStages, pushLog, completeFlow, failFlow } = useCreationFlow();

  const notice = useChatStore((state) => state.notice);
  const setNotice = useChatStore((state) => state.setNotice);
  const themeMode = useChatStore((state) => state.themeMode);
  const setThemeMode = useChatStore((state) => state.setThemeMode);
  const setInput = useChatStore((state) => state.setInput);
  const input = useChatStore((state) => state.input);

  const { loadWorldDebug, loadWorldsHandle } = useWorldSettings({
    onNotice: setNotice,
    onFatalError: setFatalError,
  });
  const worldSelectedDomainId = useWorldStore((state) => state.selectedDomainId);
  const worldDebug = useWorldStore((state) => state.worldDebug);
  const showWorldManager = useWorldStore((state) => state.showWorldManager);
  const setShowWorldManager = useWorldStore((state) => state.setShowWorldManager);
  const setSelectedDomainId = useWorldStore((state) => state.setSelectedDomainId);

  const { agents, selectedAgentId, setSelectedAgentId, loadAgents, loadConversation, prependAgentWithGreeting, removeAgentState } =
    useAgents({
      userId: USER_ID,
      selectedDomainId: worldSelectedDomainId,
      uid,
      nowTime,
      formatTimeFromIso,
      mapAgentFromApi,
      onNotice: setNotice,
      onFatalError: setFatalError,
    });

  const selectedAgent = useMemo(
    () => agents.find((item) => item.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );
  const activeDomainId = selectedAgent?.domainId || worldSelectedDomainId || worldDebug?.active_domain_id || "default";
  const domainOptions = worldDebug?.summaries?.length ? worldDebug.summaries : [{ id: "default", name: "默认陪伴域" }];
  const currentMessages = useChatStore((state) => state.messagesByAgent[selectedAgentId] ?? EMPTY_MESSAGES);

  const { selectedLiveState, displayHeartbeatBpm, displayStressLevel, displayMoodIndex, vitalsContainerRef } = useLiveState({
    userId: USER_ID,
    selectedAgent,
  });

  const setLiveState = useChatStore((state) => state.setLiveState);
  const upsertMessages = useChatStore((state) => state.upsertMessages);

  const loadFeedPosts = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) {
      return;
    }
    setFeedLoading(true);
    try {
      const rows = await listPosts(USER_ID, {
        limit: 20,
        offset: 0,
        includeArchived: false,
        domainId: worldSelectedDomainId,
        signal,
      });
      if (signal?.aborted) {
        return;
      }
      setFeedPosts([...rows.items]);
    } finally {
      if (!signal?.aborted) {
        setFeedLoading(false);
      }
    }
  }, [worldSelectedDomainId]);

  useFeedPolling(loadFeedPosts);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      document.documentElement.setAttribute("data-theme", themeMode);
    }
  }, [themeMode, mounted]);

  useEffect(() => {
    void loadWorldDebug();
    void loadWorldsHandle();
  }, [loadWorldDebug, loadWorldsHandle]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents, worldSelectedDomainId]);

  useEffect(() => {
    const agent = agents.find((item) => item.id === selectedAgentId);
    if (!agent) {
      return;
    }
    void loadConversation(agent.id, agent.name, agent.greeting);
  }, [agents, loadConversation, selectedAgentId]);

  useEffect(() => {
    const page = window.location.pathname;
    const send = () =>
      void sendHeartbeat({
        session_id: sessionId,
        page,
        mode: APP_MODE,
        user_id: USER_ID,
      });

    send();
    const heartbeatTimer = setInterval(send, POLL_INTERVALS.HEARTBEAT_TELEMETRY);
    return () => clearInterval(heartbeatTimer);
  }, [sessionId]);

  useEffect(() => {
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
    const page = window.location.pathname;
    const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const value = navEntry ? navEntry.loadEventEnd - navEntry.startTime : performance.now();

    void reportWebVital({
      name: "page_load_ms",
      value,
      page,
      metric_id: sessionId,
      rating: value > 3_000 ? "poor" : value > 1_500 ? "needs-improvement" : "good",
    });
  }, [sessionId]);

  const createAgentHandle = async () => {
    const name = draftName.trim();
    if (!name) {
      return;
    }

    const flowStart = Date.now();
    setCreatingPlaceholder({ active: true, name: `${name} (构建中)` });
    startFlow("manual", "记忆灌注引擎启动中...");
    pushLog("[System] Parsing manual profile payload...");

    try {
      const created = await createAgent({
        name,
        persona: draftPersona.trim() || "温暖、稳定、会倾听",
        background: "由你在前端创建的 AI 联系人。",
        domain_id: worldSelectedDomainId,
        hobbies: ["散步", "音乐"],
        speaking_style: draftStyle.trim() || "温柔有边界",
      });
      await runSeedAndInfraStages(created.id, "manual");
      const elapsed = Date.now() - flowStart;
      if (elapsed < ANIMATION_DELAYS.CUSTOM_CREATION_MIN_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAYS.CUSTOM_CREATION_MIN_WAIT - elapsed));
      }
      prependAgentWithGreeting(mapAgentFromApi(created, agents.length));
      setDraftName("");
      setDraftPersona("");
      setDraftStyle("");
      setShowCustomCreateForm(false);
      setShowAddFriendMenu(false);
      setCreatingPlaceholder({ active: false, name: "角色构建中..." });
      await completeFlow(created.name, "神经连接稳定，角色上线。");
      setNotice("角色创建成功");
    } catch (error) {
      setCreatingPlaceholder({ active: false, name: "角色构建中..." });
      const message = getErrorMessage(error);
      await failFlow(message);
      void reportFrontendError({
        message: `manual-create failed: ${message}`,
        page: window.location.pathname,
        source: "createAgentHandle",
        user_id: USER_ID,
      });
      setNotice(`角色创建失败: ${message}`);
    }
  };

  const aiCreateAgentHandle = async () => {
    const flowStart = Date.now();
    setCreatingPlaceholder({ active: true, name: "数字人格孵化中..." });
    startFlow("ai", "数字降生引擎启动中...");
    pushLog("[System] Retrieving shared-scope memory...");

    try {
      setRestructuringPhase("几何人格体重组中...");
      pushLog("[Kernel] Reassembling persona lattice...");
      const created = await createAgentByAi(undefined, worldSelectedDomainId);
      await runSeedAndInfraStages(created.agent.id, "ai");
      const elapsed = Date.now() - flowStart;
      if (elapsed < ANIMATION_DELAYS.AI_CREATION_MIN_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAYS.AI_CREATION_MIN_WAIT - elapsed));
      }
      prependAgentWithGreeting(mapAgentFromApi(created.agent, agents.length));
      setShowAddFriendMenu(false);
      setCreatingPlaceholder({ active: false, name: "角色构建中..." });
      await completeFlow(created.agent.name, "数字人格已定型并接入会话链路。");
      setNotice(`AI 建角成功（${created.model}）`);
    } catch (error) {
      setCreatingPlaceholder({ active: false, name: "角色构建中..." });
      const message = getErrorMessage(error);
      await failFlow(message);
      void reportFrontendError({
        message: `ai-create failed: ${message}`,
        page: window.location.pathname,
        source: "aiCreateAgentHandle",
        user_id: USER_ID,
      });
      setNotice(`AI 建角失败: ${message}`);
    }
  };

  const deleteAgentHandle = useCallback(
    async (agentId: string, agentName: string) => {
      try {
        await deleteAgent(agentId);
        removeAgentState(agentId);
        setNotice(`已删除角色: ${agentName}`);
      } catch (error) {
        setNotice(`删除失败: ${getErrorMessage(error)}`);
      }
    },
    [removeAgentState, setNotice],
  );

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || !selectedAgent || isSending) {
      return;
    }

    setIsSending(true);

    const userMessage = {
      id: uid("msg"),
      role: "user" as const,
      content: text,
      createdAt: nowTime(),
    };

    const assistantMessageId = uid("msg");
    const existing = useChatStore.getState().messagesByAgent[selectedAgentId] ?? [];
    upsertMessages(selectedAgentId, [
      ...existing,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: nowTime(),
        isStreaming: true,
      },
    ]);

    setInput("");

    try {
      await streamChat(
        {
          user_id: USER_ID,
          message: text,
          conversation_id: selectedAgentId,
          agent_id: selectedAgentId,
          domain_id: activeDomainId,
        },
        {
          onDelta: (content) => {
            const rows = useChatStore.getState().messagesByAgent[selectedAgentId] ?? [];
            const target = rows.find((msg) => msg.id === assistantMessageId);
            const nextContent = `${target?.content ?? ""}${content}`;
            upsertMessages(
              selectedAgentId,
              rows.map((msg) => (msg.id === assistantMessageId ? { ...msg, content: nextContent, isStreaming: true } : msg)),
            );
          },
          onDone: (event) => {
            const rows = useChatStore.getState().messagesByAgent[selectedAgentId] ?? [];
            upsertMessages(
              selectedAgentId,
              rows.map((msg) => (msg.id === assistantMessageId ? { ...msg, isStreaming: false } : msg)),
            );

            const previous = useChatStore.getState().liveStateByAgent[selectedAgentId];
            const nextIndex = Math.round(Math.max(0, Math.min(1, event.mood_intensity)) * 100);
            const previousIndex = previous?.mood_index ?? nextIndex;
            const trend: "up" | "down" | "steady" =
              nextIndex >= previousIndex + 6 ? "up" : nextIndex <= previousIndex - 6 ? "down" : "steady";

            setLiveState(selectedAgentId, {
              agent_id: event.agent_id,
              agent_name: event.agent_name,
              mood_label: event.emotion_label,
              mood_intensity: event.mood_intensity,
              mood_index: nextIndex,
              heartbeat_bpm: event.heartbeat_bpm,
              heartbeat_interval_ms: Math.floor(60_000 / Math.max(1, event.heartbeat_bpm)),
              stress_level: Math.max(0, Math.min(1, event.mood_intensity * (event.risk_level === "low" ? 0.4 : 0.75))),
              trend,
              risk_level: event.risk_level,
              updated_at: new Date().toISOString(),
            });
          },
        },
      );
    } catch (error) {
      const message = `聊天请求失败: ${getErrorMessage(error)}`;
      setFatalError(message);
      setNotice(message);
      throw error;
    } finally {
      setIsSending(false);
    }
  };

  const onGeneratePost = async () => {
    if (!selectedAgent || isGeneratingPost) {
      return;
    }
    setIsGeneratingPost(true);
    try {
      await generatePost(selectedAgent.id, { user_id: USER_ID });
      try {
        await loadFeedPosts(undefined);
      } catch (error) {
        setNotice(`动态加载失败: ${getErrorMessage(error)}`);
      }
      setNotice(`已生成 ${selectedAgent.name} 的新动态`);
    } catch (error) {
      setNotice(`动态生成失败: ${getErrorMessage(error)}`);
    } finally {
      setIsGeneratingPost(false);
    }
  };

  const onTriggerFromPost = async (post: PostItemDto) => {
    try {
      const payload = await triggerChatFromPost(post.id, USER_ID, activeDomainId);
      setSelectedAgentId(payload.agent_id);
      setInput(payload.suggested_message);
      setNotice("已注入话题，可直接发送");
    } catch (error) {
      setNotice(`话题注入失败: ${getErrorMessage(error)}`);
    }
  };

  const heartbeatDuration = `${Math.max(0.45, 60 / Math.max(1, displayHeartbeatBpm))}s`;

  if (fatalError) {
    return (
      <div className="app-bg min-h-screen p-4 md:p-6">
        <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-[900px] items-center justify-center rounded-[30px] border border-red-400/40 bg-[var(--surface-main)] p-8 shadow-[var(--shadow-main)]">
          <div className="space-y-3 text-center">
            <p className="text-xs uppercase tracking-[0.25em] text-red-300">Backend Error</p>
            <h1 className="text-2xl font-semibold text-[var(--text-main)]">无法连接后端服务</h1>
            <p className="text-sm text-[var(--text-muted)]">{fatalError}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-bg min-h-screen p-4 md:p-6">
      <div className="mx-auto grid h-[calc(100vh-2rem)] max-w-[1600px] grid-cols-1 overflow-hidden rounded-[30px] border border-[var(--line-soft)] bg-[var(--surface-main)] shadow-[var(--shadow-main)] backdrop-blur-sm lg:grid-cols-[320px_1fr_360px]">
        <ChatSidebar
          creatingPlaceholder={creatingPlaceholder}
          onAddFriend={() => {
            setShowAddFriendMenu((prev) => !prev);
            setShowCustomCreateForm(false);
          }}
          onDeleteAgent={deleteAgentHandle}
        />

        <ChatArea
          selectedAgentName={selectedAgent?.name}
          notice={notice}
          selectedDomainId={worldSelectedDomainId}
          domainOptions={domainOptions}
          themeMode={themeMode}
          showWorldManager={showWorldManager}
          messages={currentMessages}
          input={input}
          onInputChange={setInput}
          onThemeModeChange={setThemeMode}
          onDomainChange={(domainId) => {
            setSelectedDomainId(domainId);
            void loadWorldDebug(domainId);
          }}
          onToggleWorldManager={() => {
            const next = !showWorldManager;
            setShowWorldManager(next);
            if (next) {
              void loadWorldsHandle();
            }
          }}
          onSendMessage={(event) => void sendMessage(event)}
          isSending={isSending}
        />

        <aside className="panel-scroll flex min-h-0 flex-col border-t border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-t-0 lg:border-l">
          <div className="border-b border-[var(--line-soft)] px-4 py-3">
            <p className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">Agent 侧栏</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRightPanelTab("state")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
                  rightPanelTab === "state"
                    ? "border-[var(--line-strong)] bg-[var(--surface-card)] text-[var(--text-main)]"
                    : "border-[var(--line-soft)] text-[var(--text-muted)]"
                }`}
              >
                状态
              </button>
              <button
                type="button"
                onClick={() => setRightPanelTab("feed")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
                  rightPanelTab === "feed"
                    ? "border-[var(--line-strong)] bg-[var(--surface-card)] text-[var(--text-main)]"
                    : "border-[var(--line-soft)] text-[var(--text-muted)]"
                }`}
              >
                动态
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {rightPanelTab === "state" ? (
              <>
                {!selectedAgent ? (
                  <section className="rounded-2xl border border-dashed border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
                    当前未选择联系人
                  </section>
                ) : (
                  <section ref={vitalsContainerRef} className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-[var(--text-muted)]">当前心情</p>
                        <p className="mt-1 text-lg font-semibold text-[var(--text-main)]">{moodText(selectedLiveState?.mood_label ?? "calm")}</p>
                      </div>
                      <div className="heartbeat-core" style={{ ["--beat-duration" as string]: heartbeatDuration }}>
                        <span className="heartbeat-ring" />
                        <span className="heartbeat-dot" />
                      </div>
                    </div>
                    <div className="mt-4 h-2 rounded-full bg-white/10">
                      <div
                        className="h-2 rounded-full transition-all duration-500"
                        style={{
                          width: `${displayMoodIndex}%`,
                          backgroundImage: "linear-gradient(120deg, #8a2be2 0%, #d946ef 42%, #22d3ee 100%)",
                          boxShadow: "0 0 14px rgba(168,85,247,0.45)",
                        }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-[var(--text-muted)]">心情指数 {displayMoodIndex} / 100</p>
                  </section>
                )}

                {selectedAgent ? (
                  <section className="grid grid-cols-2 gap-2">
                    <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">心跳频率</p>
                      <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{displayHeartbeatBpm} bpm</p>
                    </article>
                    <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">压力水平</p>
                      <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{Math.round(displayStressLevel * 100)}%</p>
                      <div className="mt-2 h-1.5 rounded-full bg-white/10">
                        <div
                          className="h-1.5 rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.round(displayStressLevel * 100)}%`,
                            backgroundImage: "linear-gradient(90deg, rgba(34,211,238,0.9), rgba(244,114,182,0.95))",
                          }}
                        />
                      </div>
                    </article>
                    <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">趋势</p>
                      <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{selectedLiveState?.trend ?? "steady"}</p>
                    </article>
                    <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">最后更新</p>
                      <p className="mt-1 text-base font-semibold text-[var(--text-main)]">
                        {selectedLiveState ? formatAgo(selectedLiveState.updated_at) : "未更新"}
                      </p>
                    </article>
                  </section>
                ) : null}

                {selectedAgent ? (
                  <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
                    风险等级: <span className="text-[var(--text-main)]">{selectedLiveState?.risk_level ?? "low"}</span>
                  </section>
                ) : null}
              </>
            ) : (
              <>
                <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                  <button
                    type="button"
                    onClick={() => void onGeneratePost()}
                    disabled={isGeneratingPost || !selectedAgent}
                    className="w-full rounded-xl bg-[var(--brand-main)] px-4 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.02] disabled:opacity-60"
                  >
                    {isGeneratingPost ? "生成中..." : `让 ${selectedAgent?.name ?? "AI"} 发一条动态`}
                  </button>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">点击动态卡片可将话题注入输入框。</p>
                </section>

                {feedLoading ? <p className="text-xs text-[var(--text-muted)]">动态加载中...</p> : null}

                {!feedLoading && feedPosts.length === 0 ? (
                  <section className="rounded-2xl border border-dashed border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
                    还没有动态，先生成一条试试。
                  </section>
                ) : null}

                {feedPosts.map((post) => (
                  <button
                    key={post.id}
                    type="button"
                    onClick={() => void onTriggerFromPost(post)}
                    className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-left transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{post.agent_name}</p>
                      <p className="text-xs text-[var(--text-muted)]">{formatAgo(post.created_at)}</p>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--text-main)]">{post.content}</p>
                    <p className="mt-2 text-xs text-[var(--text-muted)]">话题: {post.topic_seed}</p>
                  </button>
                ))}
              </>
            )}

            {showAddFriendMenu ? (
              <section className="friend-pop space-y-3 border-t border-[var(--line-soft)] pt-3">
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">添加好友</p>
                {!showCustomCreateForm ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowCustomCreateForm(true)}
                      className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] px-4 py-3 text-left text-sm font-semibold text-[var(--text-main)] transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
                    >
                      自定义你的ta
                    </button>
                    <button
                      type="button"
                      onClick={() => void aiCreateAgentHandle()}
                      className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] px-4 py-3 text-left text-sm font-semibold text-[var(--text-main)] transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
                    >
                      你有一个好友申请
                    </button>
                  </>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createAgentHandle();
                    }}
                    className="friend-pop space-y-2 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 shadow-[var(--shadow-neon)]"
                  >
                    <p className="text-sm font-semibold text-[var(--text-main)]">自定义你的ta</p>
                    <input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      placeholder="昵称"
                      className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                    />
                    <input
                      value={draftPersona}
                      onChange={(event) => setDraftPersona(event.target.value)}
                      placeholder="个性"
                      className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                    />
                    <input
                      value={draftStyle}
                      onChange={(event) => setDraftStyle(event.target.value)}
                      placeholder="说话风格"
                      className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="flex-1 rounded-lg bg-[var(--brand-main)] px-3 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(217,70,239,0.45)]"
                      >
                        添加
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCustomCreateForm(false)}
                        className="rounded-lg border border-[var(--line-soft)] px-3 py-2 text-sm text-[var(--text-main)]"
                      >
                        返回
                      </button>
                    </div>
                  </form>
                )}
              </section>
            ) : null}
          </div>
        </aside>
      </div>

      <CreationOverlay overlay={overlay} creationLabel={creationLabel} />
    </div>
  );
}
