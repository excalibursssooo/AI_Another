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
import { RightPanel } from "@/features/chat/components/RightPanel";
import { useAgents } from "@/features/chat/hooks/useAgents";
import { useCreationFlow } from "@/features/chat/hooks/useCreationFlow";
import { useFeedPolling } from "@/features/chat/hooks/useFeedPolling";
import { useLiveState } from "@/features/chat/hooks/useLiveState";
import { useWorldSettings } from "@/features/chat/hooks/useWorldSettings";
import { useChatStore } from "@/stores/useChatStore";
import { useWorldStore } from "@/stores/useWorldStore";

function getEnvUserId(): string {
  const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID?.trim();
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
  const bindVitalsContainer = useCallback(
    (element: HTMLDivElement | null) => {
      vitalsContainerRef.current = element;
    },
    [vitalsContainerRef],
  );

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

    const clientActionId = crypto.randomUUID();

    const userMessage = {
      id: uid("msg"),
      clientActionId,
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
          client_action_id: clientActionId,
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

        <RightPanel
          activeTab={rightPanelTab}
          selectedAgent={selectedAgent}
          selectedLiveState={selectedLiveState}
          displayMoodIndex={displayMoodIndex}
          displayHeartbeatBpm={displayHeartbeatBpm}
          displayStressLevel={displayStressLevel}
          heartbeatDuration={heartbeatDuration}
          onVitalsContainerElement={bindVitalsContainer}
          feedPosts={feedPosts}
          feedLoading={feedLoading}
          isGeneratingPost={isGeneratingPost}
          showAddFriendMenu={showAddFriendMenu}
          showCustomCreateForm={showCustomCreateForm}
          draftName={draftName}
          draftPersona={draftPersona}
          draftStyle={draftStyle}
          formatAgo={formatAgo}
          onTabChange={setRightPanelTab}
          onGeneratePost={() => void onGeneratePost()}
          onTriggerFromPost={(post) => void onTriggerFromPost(post)}
          onShowCustomCreateFormChange={setShowCustomCreateForm}
          onAiCreateAgent={() => void aiCreateAgentHandle()}
          onCreateAgent={() => void createAgentHandle()}
          onDraftNameChange={setDraftName}
          onDraftPersonaChange={setDraftPersona}
          onDraftStyleChange={setDraftStyle}
        />
      </div>

      <CreationOverlay overlay={overlay} creationLabel={creationLabel} />
    </div>
  );
}
