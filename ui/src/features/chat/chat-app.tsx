"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createAgent,
  createAgentByAi,
  debugAgentMemorySeed,
  generatePost,
  getInfraDebug,
  getAgentLiveState,
  listConversationTurns,
  listAgents,
  listPosts,
  streamChat,
  triggerChatFromPost,
} from "@/lib/api/companion";
import { AgentLiveStateDto, AgentResponseDto, PostItemDto } from "@/lib/api/types";
import { reportFrontendError, reportWebVital, sendHeartbeat } from "@/lib/api/telemetry";
import { seedAgents, seedMessages } from "@/lib/mock/seed";
import { AiAgent, ChatMessage } from "@/features/chat/types";
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

function buildAssistantReply(agent: AiAgent, text: string): string {
  if (!text.trim()) {
    return "我在，慢慢来。你先说一句最想被理解的话。";
  }

  return `我听到了你说“${text.trim()}”。以${agent.name}的方式，我建议先做一个最小动作：把这件事拆成今天可以完成的第一步。你不用一次解决全部，我会陪你走完。`;
}

type CreationMode = "ai" | "manual";
type CreationPhase = "idle" | "parsing" | "restructuring" | "memory" | "diagnose" | "complete" | "error";

interface CreationOverlayState {
  active: boolean;
  mode: CreationMode;
  phase: CreationPhase;
  progress: number;
  logs: string[];
  message: string;
  error: string;
  signature: string;
  memoryNodesLit: number;
  exploding: boolean;
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
  const [agents, setAgents] = useState<AiAgent[]>(seedAgents);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(seedAgents[0].id);
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>(seedMessages);
  const [input, setInput] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);
  const [showAddFriendMenu, setShowAddFriendMenu] = useState<boolean>(false);
  const [showCustomCreateForm, setShowCustomCreateForm] = useState<boolean>(false);
  const [liveStateByAgent, setLiveStateByAgent] = useState<Record<string, AgentLiveStateDto>>({});
  const [displayHeartbeatBpm, setDisplayHeartbeatBpm] = useState<number>(72);
  const [displayStressLevel, setDisplayStressLevel] = useState<number>(0.2);
  const [displayMoodIndex, setDisplayMoodIndex] = useState<number>(35);
  const [notice, setNotice] = useState<string>(USE_MOCK ? "当前为 Mock 模式" : "正在连接后端...");
  const [rightPanelTab, setRightPanelTab] = useState<"state" | "feed">("state");
  const [feedPosts, setFeedPosts] = useState<PostItemDto[]>([]);
  const [feedLoading, setFeedLoading] = useState<boolean>(false);
  const [isGeneratingPost, setIsGeneratingPost] = useState<boolean>(false);
  const [creatingPlaceholder, setCreatingPlaceholder] = useState<{ active: boolean; name: string }>({
    active: false,
    name: "角色构建中...",
  });
  const [creationOverlay, setCreationOverlay] = useState<CreationOverlayState>({
    active: false,
    mode: "ai",
    phase: "idle",
    progress: 0,
    logs: [],
    message: "",
    error: "",
    signature: "",
    memoryNodesLit: 0,
    exploding: false,
  });

  const [draftName, setDraftName] = useState<string>("");
  const [draftPersona, setDraftPersona] = useState<string>("");
  const [draftStyle, setDraftStyle] = useState<string>("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string>(uid("session"));

  const pushCreationLog = useCallback((line: string) => {
    setCreationOverlay((prev) => ({
      ...prev,
      logs: [...prev.logs, line].slice(-6),
    }));
  }, []);

  const startCreationFlow = useCallback((mode: CreationMode, message: string) => {
    setCreationOverlay({
      active: true,
      mode,
      phase: mode === "ai" ? "parsing" : "memory",
      progress: 8,
      logs: ["[System] Booting persona forge kernel..."],
      message,
      error: "",
      signature: "",
      memoryNodesLit: 0,
      exploding: false,
    });
  }, []);

  const completeCreationFlow = useCallback(async (signature: string, nextMessage: string) => {
    setCreationOverlay((prev) => ({
      ...prev,
      phase: "complete",
      progress: 100,
      message: nextMessage,
      signature,
      exploding: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 620));
    setCreationOverlay((prev) => ({ ...prev, active: false, exploding: false }));
  }, []);

  const failCreationFlow = useCallback(async (errorMessage: string) => {
    setCreationOverlay((prev) => ({
      ...prev,
      phase: "error",
      progress: Math.max(prev.progress, 38),
      error: errorMessage,
      message: "创建失败，系统核心断裂。",
      logs: [...prev.logs, `[Error] ${errorMessage}`].slice(-6),
    }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    setCreationOverlay((prev) => ({ ...prev, active: false, exploding: false }));
  }, []);

  const runSeedAndInfraStages = useCallback(
    async (agentId: string, mode: CreationMode) => {
      if (mode === "manual") {
        setCreationOverlay((prev) => ({
          ...prev,
          phase: "memory",
          progress: Math.max(prev.progress, 32),
          message: "正在初始化角色设定记忆...",
        }));
      } else {
        setCreationOverlay((prev) => ({
          ...prev,
          phase: "restructuring",
          progress: Math.max(prev.progress, 38),
          message: "人格拼接矩阵重组中...",
        }));
      }
      pushCreationLog("[Kernel] Injecting subject identifiers: user/agent...");

      let seededCount = 0;
      try {
        const seedResult = await debugAgentMemorySeed(agentId, {
          dry_run: false,
          force_reextract: false,
        });
        seededCount = Math.max(seedResult.persisted_count, seedResult.candidate_count);
        setCreationOverlay((prev) => ({
          ...prev,
          memoryNodesLit: Math.max(1, Math.min(8, seededCount)),
          progress: Math.max(prev.progress, 72),
        }));
        pushCreationLog(`[System] memory-seed persisted=${seedResult.persisted_count}`);
      } catch (error) {
        pushCreationLog(`[System] memory-seed skipped: ${(error as Error).message}`);
      }

      setCreationOverlay((prev) => ({
        ...prev,
        phase: "diagnose",
        progress: Math.max(prev.progress, 82),
        message: "正在进行基础设施诊断...",
      }));
      pushCreationLog("[System] Retrieving shared-scope memory...");
      try {
        const infra = await getInfraDebug();
        pushCreationLog(
          `[Ready] infra postgres=${infra.postgres.reachable ? "ok" : "down"}, qdrant=${infra.qdrant.reachable ? "ok" : "down"}`,
        );
      } catch (error) {
        pushCreationLog(`[System] infra-check degraded: ${(error as Error).message}`);
      }
    },
    [pushCreationLog],
  );

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
  const selectedLiveState = selectedAgent ? liveStateByAgent[selectedAgent.id] : undefined;

  const visibleMessages = messagesByAgent[selectedAgentId] ?? [];

  useEffect(() => {
    if (!selectedAgent) {
      return;
    }

    if (USE_MOCK) {
      setLiveStateByAgent((prev) => ({
        ...prev,
        [selectedAgent.id]: {
          agent_id: selectedAgent.id,
          agent_name: selectedAgent.name,
          mood_label: "calm",
          mood_intensity: 0.35,
          mood_index: 35,
          heartbeat_bpm: 72,
          heartbeat_interval_ms: Math.floor(60_000 / 72),
          stress_level: 0.2,
          trend: "steady",
          risk_level: "low",
          updated_at: new Date().toISOString(),
        },
      }));
      return;
    }

    let disposed = false;
    const load = async () => {
      try {
        const state = await getAgentLiveState(USER_ID, selectedAgent.id);
        if (disposed) {
          return;
        }
        setLiveStateByAgent((prev) => ({
          ...prev,
          [selectedAgent.id]: state,
        }));
      } catch {
        // Keep previous state if polling fails.
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 4_000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selectedAgent]);

  const loadFeedPosts = useCallback(async () => {
    if (USE_MOCK) {
      setFeedPosts([]);
      return;
    }

    setFeedLoading(true);
    try {
      const rows = await listPosts(USER_ID, { limit: 20, offset: 0, includeArchived: false });
      setFeedPosts(rows.items);
    } catch (error) {
      setNotice(`动态加载失败: ${(error as Error).message}`);
    } finally {
      setFeedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (USE_MOCK) {
      return;
    }

    void loadFeedPosts();
    const timer = setInterval(() => {
      void loadFeedPosts();
    }, 12_000);
    return () => clearInterval(timer);
  }, [loadFeedPosts]);

  useEffect(() => {
    const baseHeartbeat = selectedLiveState?.heartbeat_bpm ?? 72;
    const baseStress = selectedLiveState?.stress_level ?? 0.2;
    const baseMood = selectedLiveState?.mood_index ?? 35;
    setDisplayHeartbeatBpm(baseHeartbeat);
    setDisplayStressLevel(baseStress);
    setDisplayMoodIndex(baseMood);

    const timer = setInterval(() => {
      const t = Date.now() / 1000;
      const heartbeatJitter = 2.6 * Math.sin(t * 2.2) + 1.3 * Math.sin(t * 3.7);
      const stressJitter = 0.035 * Math.sin(t * 1.8);
      const moodJitter = 1.9 * Math.sin(t * 1.2);

      setDisplayHeartbeatBpm(Math.max(55, Math.min(130, Math.round(baseHeartbeat + heartbeatJitter))));
      setDisplayStressLevel(Math.max(0, Math.min(1, baseStress + stressJitter)));
      setDisplayMoodIndex(Math.max(0, Math.min(100, Math.round(baseMood + moodJitter))));
    }, 900);

    return () => clearInterval(timer);
  }, [selectedLiveState?.heartbeat_bpm, selectedLiveState?.stress_level, selectedLiveState?.mood_index]);

  const createAgentHandle = async () => {
    const name = draftName.trim();
    if (!name) {
      return;
    }

    const customDelayMs = 1_400;
    const flowStart = Date.now();
    setCreatingPlaceholder({ active: true, name: `${name} (构建中)` });
    startCreationFlow("manual", "记忆灌注引擎启动中...");
    pushCreationLog("[System] Parsing manual profile payload...");

    if (!USE_MOCK) {
      try {
        const created = await createAgent({
          name,
          persona: draftPersona.trim() || "温暖、稳定、会倾听",
          background: "由你在前端创建的 AI 联系人。",
          hobbies: ["散步", "音乐"],
          speaking_style: draftStyle.trim() || "温柔有边界",
        });
        await runSeedAndInfraStages(created.id, "manual");
        const elapsed = Date.now() - flowStart;
        if (elapsed < customDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, customDelayMs - elapsed));
        }
        const mapped = mapAgentFromApi(created, agents.length);
        setAgents((prev) => [mapped, ...prev]);
        setSelectedAgentId(mapped.id);
        setDraftName("");
        setDraftPersona("");
        setDraftStyle("");
        setShowCustomCreateForm(false);
        setShowAddFriendMenu(false);
        setCreatingPlaceholder({ active: false, name: "角色构建中..." });
        await completeCreationFlow(mapped.name, "神经连接稳定，角色上线。" );
        setNotice("角色创建成功");
        return;
      } catch (error) {
        setCreatingPlaceholder({ active: false, name: "角色构建中..." });
        await failCreationFlow((error as Error).message);
        void reportFrontendError({
          message: `manual-create failed: ${(error as Error).message}`,
          page: window.location.pathname,
          source: "createAgentHandle",
          user_id: USER_ID,
        });
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
    setShowCustomCreateForm(false);
    setShowAddFriendMenu(false);
    setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    await completeCreationFlow(newAgent.name, "记忆灌注完成，角色上线。" );
  };

  const aiCreateAgentHandle = async () => {
    const aiDelayMs = 1_900;
    const flowStart = Date.now();
    setCreatingPlaceholder({ active: true, name: "数字人格孵化中..." });
    startCreationFlow("ai", "数字降生引擎启动中...");
    pushCreationLog("[System] Retrieving shared-scope memory...");

    if (!USE_MOCK) {
      try {
        setCreationOverlay((prev) => ({
          ...prev,
          phase: "restructuring",
          progress: 30,
          message: "几何人格体重组中...",
        }));
        pushCreationLog("[Kernel] Reassembling persona lattice...");
        const created = await createAgentByAi();
        await runSeedAndInfraStages(created.agent.id, "ai");
        const elapsed = Date.now() - flowStart;
        if (elapsed < aiDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, aiDelayMs - elapsed));
        }
        const mapped = mapAgentFromApi(created.agent, agents.length);
        setAgents((prev) => [mapped, ...prev]);
        setSelectedAgentId(mapped.id);
        setShowAddFriendMenu(false);
        setCreatingPlaceholder({ active: false, name: "角色构建中..." });
        await completeCreationFlow(mapped.name, "数字人格已定型并接入会话链路。" );
        setNotice(`AI 建角成功（${created.model}）`);
        return;
      } catch (error) {
        setCreatingPlaceholder({ active: false, name: "角色构建中..." });
        await failCreationFlow((error as Error).message);
        void reportFrontendError({
          message: `ai-create failed: ${(error as Error).message}`,
          page: window.location.pathname,
          source: "aiCreateAgentHandle",
          user_id: USER_ID,
        });
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
    setShowAddFriendMenu(false);
    setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    await completeCreationFlow(generated.name, "模拟人格生成完成。" );
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
            onDone: (event) => {
              setMessagesByAgent((prev) => {
                const existing = prev[selectedAgentId] ?? [];
                return {
                  ...prev,
                  [selectedAgentId]: existing.map((msg) =>
                    msg.id === assistantMessageId ? { ...msg, isStreaming: false } : msg,
                  ),
                };
              });

              setLiveStateByAgent((prev) => {
                const previous = prev[selectedAgentId];
                const nextIndex = Math.round(Math.max(0, Math.min(1, event.mood_intensity)) * 100);
                const previousIndex = previous?.mood_index ?? nextIndex;
                const trend: "up" | "down" | "steady" =
                  nextIndex >= previousIndex + 6 ? "up" : nextIndex <= previousIndex - 6 ? "down" : "steady";

                return {
                  ...prev,
                  [selectedAgentId]: {
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
                  },
                };
              });
            },
          },
        );
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

  const onGeneratePost = async () => {
    if (!selectedAgent || isGeneratingPost || USE_MOCK) {
      return;
    }
    setIsGeneratingPost(true);
    try {
      await generatePost(selectedAgent.id, { user_id: USER_ID });
      await loadFeedPosts();
      setNotice(`已生成 ${selectedAgent.name} 的新动态`);
    } catch (error) {
      setNotice(`动态生成失败: ${(error as Error).message}`);
    } finally {
      setIsGeneratingPost(false);
    }
  };

  const onTriggerFromPost = async (post: PostItemDto) => {
    if (USE_MOCK) {
      setInput(post.topic_seed);
      return;
    }

    try {
      const payload = await triggerChatFromPost(post.id, USER_ID);
      setSelectedAgentId(payload.agent_id);
      setInput(payload.suggested_message);
      setNotice("已注入话题，可直接发送");
    } catch (error) {
      setNotice(`话题注入失败: ${(error as Error).message}`);
    }
  };

  const heartbeatDuration = `${Math.max(0.45, 60 / Math.max(1, displayHeartbeatBpm))}s`;

  return (
    <div className="app-bg min-h-screen p-4 md:p-6">
      <div className="mx-auto grid h-[calc(100vh-2rem)] max-w-[1600px] grid-cols-1 overflow-hidden rounded-[30px] border border-[var(--line-soft)] bg-[var(--surface-main)] shadow-[var(--shadow-main)] backdrop-blur-sm lg:grid-cols-[320px_1fr_360px]">
        <aside className="panel-scroll flex min-h-0 flex-col border-b border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-r lg:border-b-0">
          <div className="relative px-5 pt-6 pb-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">AI Contacts</p>
              <button
                type="button"
                onClick={() => {
                  setShowAddFriendMenu((prev) => !prev);
                  setShowCustomCreateForm(false);
                }}
                className="friend-fab absolute top-4 right-5 z-10 h-12 w-12 text-xl font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-110"
                aria-label="添加好友"
              >
                +
              </button>
            </div>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--text-main)]">联系人</h2>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
            {creatingPlaceholder.active ? (
              <div className="agent-placeholder-card rounded-2xl border px-3 py-3 text-left">
                <div className="flex items-center gap-3">
                  <span className="agent-placeholder-avatar h-9 w-9 rounded-full" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--text-main)]">{creatingPlaceholder.name}</p>
                    <p className="truncate text-xs text-[var(--text-muted)]">正在建立神经连接...</p>
                  </div>
                </div>
              </div>
            ) : null}
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
                      <p className="truncate text-xs text-[var(--text-muted)]">在线</p>
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
                <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-[var(--text-muted)]">当前心情</p>
                  <p className="mt-1 text-lg font-semibold text-[var(--text-main)]">
                    {moodText(selectedLiveState?.mood_label ?? "calm")}
                  </p>
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

                <section className="grid grid-cols-2 gap-2">
              <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                <p className="text-xs text-[var(--text-muted)]">心跳频率</p>
                <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{displayHeartbeatBpm} bpm</p>
              </article>
              <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                <p className="text-xs text-[var(--text-muted)]">压力水平</p>
                <p className="mt-1 text-base font-semibold text-[var(--text-main)]">
                  {Math.round(displayStressLevel * 100)}%
                </p>
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

                <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
                  风险等级: <span className="text-[var(--text-main)]">{selectedLiveState?.risk_level ?? "low"}</span>
                </section>
              </>
            ) : (
              <>
                <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
                  <button
                    type="button"
                    onClick={() => void onGeneratePost()}
                    disabled={isGeneratingPost || !selectedAgent || USE_MOCK}
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

      {creationOverlay.active ? (
        <div className={`creation-overlay ${creationOverlay.mode} ${creationOverlay.phase} ${creationOverlay.exploding ? "explode" : ""}`}>
          <div className="creation-veil" />
          <div className="creation-panel">
            <div className="creation-core-wrap">
              {creationOverlay.mode === "ai" ? (
                <div className="digital-core" aria-hidden>
                  <div className="dodeca dodeca-a" />
                  <div className="dodeca dodeca-b" />
                  <div className="arc-electric arc-1" />
                  <div className="arc-electric arc-2" />
                </div>
              ) : (
                <div className="memory-core" aria-hidden>
                  <div className="memory-stream" />
                  <div className="memory-stream delay" />
                  <div className="neural-grid" />
                </div>
              )}
            </div>

            <p className="creation-mode">{creationOverlay.mode === "ai" ? "数字降生" : "记忆灌注"}</p>
            <p className="creation-phase">{creationLabel(creationOverlay.phase)}</p>
            <p className="creation-message">{creationOverlay.error || creationOverlay.message}</p>

            <div className="neon-loading-track" role="progressbar" aria-valuenow={creationOverlay.progress}>
              <div className="neon-loading-fill" style={{ width: `${creationOverlay.progress}%` }} />
            </div>

            {creationOverlay.mode === "manual" ? (
              <div className="memory-nodes" aria-hidden>
                {Array.from({ length: 8 }).map((_, idx) => (
                  <span key={`node-${idx}`} className={`memory-node ${idx < creationOverlay.memoryNodesLit ? "lit" : ""}`} />
                ))}
              </div>
            ) : null}

            <div className="creation-logs">
              {creationOverlay.logs.map((line, idx) => (
                <p key={`${line}-${idx}`}>{line}</p>
              ))}
            </div>

            {creationOverlay.signature ? <p className="creation-signature">#{creationOverlay.signature}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
