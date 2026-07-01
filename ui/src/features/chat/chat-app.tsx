"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChatMessage } from "@/features/chat/types";
import { ChatArea } from "@/features/chat/components/ChatArea";
import { ChatSidebar } from "@/features/chat/components/ChatSidebar";
import { CreationOverlay } from "@/features/chat/components/CreationOverlay";
import { RightPanel } from "@/features/chat/components/RightPanel";
import { useAgents } from "@/features/chat/hooks/useAgents";
import { useAgentCreation } from "@/features/chat/hooks/useAgentCreation";
import { useAgentDeletion } from "@/features/chat/hooks/useAgentDeletion";
import { useChatTelemetry } from "@/features/chat/hooks/useChatTelemetry";
import { useFeedActions } from "@/features/chat/hooks/useFeedActions";
import { useChatSending } from "@/features/chat/hooks/useChatSending";
import { useLiveState } from "@/features/chat/hooks/useLiveState";
import { useWorldSettings } from "@/features/chat/hooks/useWorldSettings";
import { mapAgentFromApi } from "@/features/chat/utils/agentMapping";
import { formatAgo, formatTimeFromIso, nowTime, uid } from "@/features/chat/utils/chatFormatting";
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
  const [rightPanelTab, setRightPanelTab] = useState<"state" | "feed">("state");
  const [showAddFriendMenu, setShowAddFriendMenu] = useState<boolean>(false);
  const [showCustomCreateForm, setShowCustomCreateForm] = useState<boolean>(false);
  const [draftName, setDraftName] = useState<string>("");
  const [draftPersona, setDraftPersona] = useState<string>("");
  const [draftStyle, setDraftStyle] = useState<string>("");
  const sessionId = useMemo(() => uid("session"), []);
  useChatTelemetry({ sessionId, mode: APP_MODE, userId: USER_ID });

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

  const { feedPosts, feedLoading, isGeneratingPost, onGeneratePost, onTriggerFromPost } = useFeedActions({
    userId: USER_ID,
    selectedDomainId: worldSelectedDomainId,
    activeDomainId,
    selectedAgent,
    setSelectedAgentId,
    setInput,
    onNotice: setNotice,
  });

  const { overlay, creatingPlaceholder, createAgentHandle, aiCreateAgentHandle } = useAgentCreation({
    selectedDomainId: worldSelectedDomainId,
    agentsCount: agents.length,
    userId: USER_ID,
    draftName,
    draftPersona,
    draftStyle,
    mapAgentFromApi,
    prependAgentWithGreeting,
    setDraftName,
    setDraftPersona,
    setDraftStyle,
    setShowCustomCreateForm,
    setShowAddFriendMenu,
    onNotice: setNotice,
  });

  const { deleteAgentHandle } = useAgentDeletion({
    removeAgentState,
    onNotice: setNotice,
  });

  const { isSending, sendMessage } = useChatSending({
    input,
    selectedAgent,
    selectedAgentId,
    userId: USER_ID,
    activeDomainId,
    uid,
    nowTime,
    setInput,
    setFatalError,
    setNotice,
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
  }, [themeMode]);

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
