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
import { reportFrontendError } from "@/lib/api/telemetry";
import { getErrorMessage } from "@/lib/utils/error";
import { ANIMATION_DELAYS } from "@/config/constants";
import { ChatMessage } from "@/features/chat/types";
import { ChatArea } from "@/features/chat/components/ChatArea";
import { ChatSidebar } from "@/features/chat/components/ChatSidebar";
import { CreationOverlay } from "@/features/chat/components/CreationOverlay";
import { RightPanel } from "@/features/chat/components/RightPanel";
import { useAgents } from "@/features/chat/hooks/useAgents";
import { useCreationFlow } from "@/features/chat/hooks/useCreationFlow";
import { useChatTelemetry } from "@/features/chat/hooks/useChatTelemetry";
import { useFeedPolling } from "@/features/chat/hooks/useFeedPolling";
import { useLiveState } from "@/features/chat/hooks/useLiveState";
import { useWorldSettings } from "@/features/chat/hooks/useWorldSettings";
import { mapAgentFromApi } from "@/features/chat/utils/agentMapping";
import { formatAgo, formatTimeFromIso, nowTime, uid } from "@/features/chat/utils/chatFormatting";
import { createLiveStateFromChatDone } from "@/features/chat/utils/liveState";
import { createOptimisticChatExchange } from "@/features/chat/utils/optimisticMessages";
import { appendAssistantDelta, finishAssistantStreaming } from "@/features/chat/utils/streamingMessages";
import { useChatStore } from "@/stores/useChatStore";
import { useWorldStore } from "@/stores/useWorldStore";

function getEnvUserId(): string {
  const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID?.trim();
  return userId || "u001";
}

const USER_ID = getEnvUserId();
const APP_MODE = "live";
const EMPTY_MESSAGES: ChatMessage[] = [];

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
  useChatTelemetry({ sessionId, mode: APP_MODE, userId: USER_ID });
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

    const existing = useChatStore.getState().messagesByAgent[selectedAgentId] ?? [];
    const { clientActionId, assistantMessageId, messages } = createOptimisticChatExchange({
      text,
      existing,
      uid,
      now: nowTime,
      createClientActionId: () => crypto.randomUUID(),
    });
    upsertMessages(selectedAgentId, messages);

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
            upsertMessages(selectedAgentId, appendAssistantDelta(rows, assistantMessageId, content));
          },
          onDone: (event) => {
            const rows = useChatStore.getState().messagesByAgent[selectedAgentId] ?? [];
            upsertMessages(selectedAgentId, finishAssistantStreaming(rows, assistantMessageId));

            const previous = useChatStore.getState().liveStateByAgent[selectedAgentId];
            setLiveState(
              selectedAgentId,
              createLiveStateFromChatDone({
                event,
                previous,
                now: () => new Date().toISOString(),
              }),
            );
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

      <CreationOverlay overlay={overlay} />
    </div>
  );
}
