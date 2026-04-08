import { useCallback, useEffect, useRef } from "react";

import { listAgents, listConversationTurns } from "@/lib/api/companion";
import { AgentResponseDto } from "@/lib/api/types_api";
import { getErrorMessage } from "@/lib/utils/error";
import { AiAgent, ChatMessage } from "@/features/chat/types";
import { useChatStore } from "@/stores/useChatStore";

interface UseAgentsOptions {
  userId: string;
  selectedDomainId: string;
  uid: (prefix: string) => string;
  nowTime: () => string;
  formatTimeFromIso: (value: string) => string;
  mapAgentFromApi: (item: AgentResponseDto, index: number) => AiAgent;
  onNotice: (message: string) => void;
  onFatalError: (message: string) => void;
}

interface UseAgentsResult {
  agents: AiAgent[];
  selectedAgentId: string;
  messagesByAgent: Record<string, ChatMessage[]>;
  setSelectedAgentId: (agentId: string) => void;
  loadAgents: () => Promise<void>;
  loadConversation: (agentId: string, agentName: string, greeting?: string) => Promise<void>;
  prependAgentWithGreeting: (agent: AiAgent) => void;
  removeAgentState: (agentId: string) => void;
}

export function useAgents(options: UseAgentsOptions): UseAgentsResult {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const agents = useChatStore((state) => state.agents);
  const selectedAgentId = useChatStore((state) => state.selectedAgentId);
  const messagesByAgent = useChatStore((state) => state.messagesByAgent);
  const setAgents = useChatStore((state) => state.setAgents);
  const setSelectedAgentId = useChatStore((state) => state.setSelectedAgentId);
  const upsertMessages = useChatStore((state) => state.upsertMessages);
  const prependAgent = useChatStore((state) => state.prependAgent);
  const removeAgent = useChatStore((state) => state.removeAgent);
  const removeMessages = useChatStore((state) => state.removeMessages);
  const removeLiveState = useChatStore((state) => state.removeLiveState);

  const loadConversation = useCallback(
    async (agentId: string, agentName: string, greeting?: string) => {
      const current = optionsRef.current;
      try {
        const rows = await listConversationTurns(current.userId, agentId, 120);
        if (!rows.length) {
          const existing = useChatStore.getState().messagesByAgent[agentId] ?? [];
          if (existing.length === 0) {
            upsertMessages(agentId, [
              {
                id: current.uid("msg"),
                role: "assistant",
                content: greeting?.trim() || `你好，我是${agentName}。我们从你现在最在意的一件事开始。`,
                createdAt: current.nowTime(),
              },
            ]);
          }
          return;
        }

        upsertMessages(
          agentId,
          rows.map((item, index) => ({
            id: `${agentId}-${index}-${item.created_at}`,
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content,
            createdAt: current.formatTimeFromIso(item.created_at),
          })),
        );
      } catch (error) {
        current.onNotice(`历史消息加载失败: ${getErrorMessage(error)}`);
      }
    },
    [upsertMessages],
  );

  const loadAgents = useCallback(async () => {
    const currentOptions = optionsRef.current;
    try {
      const rows = await listAgents(true, currentOptions.selectedDomainId);
      const mapped = rows.map(currentOptions.mapAgentFromApi).filter((item) => item.status === "active");
      if (!mapped.length) {
        setAgents([]);
        setSelectedAgentId("");
        currentOptions.onNotice("当前世界暂无联系人");
        return;
      }

      setAgents(mapped);
      const currentSelectedId = useChatStore.getState().selectedAgentId;
      const nextSelected = mapped.some((item) => item.id === currentSelectedId) ? currentSelectedId : mapped[0].id;
      setSelectedAgentId(nextSelected);

      const state = useChatStore.getState();
      for (const agent of mapped) {
        if (!state.messagesByAgent[agent.id]) {
          upsertMessages(agent.id, [
            {
              id: currentOptions.uid("msg"),
              role: "assistant",
              content: agent.greeting?.trim() || `你好，我是${agent.name}`,
              createdAt: currentOptions.nowTime(),
            },
          ]);
        }
      }
      currentOptions.onNotice("已连接真实后端");
    } catch (error) {
      const message = `后端连接失败: ${getErrorMessage(error)}`;
      currentOptions.onFatalError(message);
      currentOptions.onNotice(message);
    }
  }, [setAgents, setSelectedAgentId, upsertMessages]);

  const prependAgentWithGreeting = useCallback(
    (agent: AiAgent) => {
      const current = optionsRef.current;
      prependAgent(agent);
      upsertMessages(agent.id, [
        {
          id: current.uid("msg"),
          role: "assistant",
          content: agent.greeting?.trim() || `你好，我是${agent.name}`,
          createdAt: current.nowTime(),
        },
      ]);
      setSelectedAgentId(agent.id);
    },
    [prependAgent, setSelectedAgentId, upsertMessages],
  );

  const removeAgentState = useCallback(
    (agentId: string) => {
      removeAgent(agentId);
      removeMessages(agentId);
      removeLiveState(agentId);
      const nextAgents = useChatStore.getState().agents;
      if (selectedAgentId === agentId) {
        setSelectedAgentId(nextAgents[0]?.id ?? "");
      }
    },
    [removeAgent, removeLiveState, removeMessages, selectedAgentId, setSelectedAgentId],
  );

  return {
    agents,
    selectedAgentId,
    messagesByAgent,
    setSelectedAgentId,
    loadAgents,
    loadConversation,
    prependAgentWithGreeting,
    removeAgentState,
  };
}
