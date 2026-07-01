import { FormEvent, useCallback, useState } from "react";

import { streamChat } from "@/lib/api/companion";
import type { AgentLiveStateDto, ChatDoneEvent, ChatRequestDto } from "@/lib/api/types_api";
import { getErrorMessage } from "@/lib/utils/error";
import type { AiAgent, ChatMessage } from "@/features/chat/types";
import { createLiveStateFromChatDone } from "@/features/chat/utils/liveState";
import { createOptimisticChatExchange } from "@/features/chat/utils/optimisticMessages";
import { appendAssistantDelta, finishAssistantStreaming } from "@/features/chat/utils/streamingMessages";
import { useChatStore } from "@/stores/useChatStore";

type StreamChat = (
  payload: ChatRequestDto,
  handlers: {
    onDelta: (content: string) => void;
    onDone: (event: ChatDoneEvent) => void;
  },
) => Promise<void>;

interface SendChatMessageActionOptions {
  input: string;
  selectedAgent: AiAgent | undefined;
  selectedAgentId: string;
  isSending: boolean;
  userId: string;
  activeDomainId: string;
  uid: (prefix: string) => string;
  nowTime: () => string;
  createClientActionId: () => string;
  nowIso: () => string;
  streamChat: StreamChat;
  getMessages: (agentId: string) => ReadonlyArray<ChatMessage>;
  getLiveState: (agentId: string) => AgentLiveStateDto | undefined;
  upsertMessages: (agentId: string, messages: ChatMessage[]) => void;
  setLiveState: (agentId: string, state: AgentLiveStateDto) => void;
  setInput: (value: string) => void;
  setIsSending: (value: boolean) => void;
  setFatalError: (message: string) => void;
  setNotice: (message: string) => void;
}

interface UseChatSendingOptions {
  input: string;
  selectedAgent: AiAgent | undefined;
  selectedAgentId: string;
  userId: string;
  activeDomainId: string;
  uid: (prefix: string) => string;
  nowTime: () => string;
  setInput: (value: string) => void;
  setFatalError: (message: string) => void;
  setNotice: (message: string) => void;
}

export async function sendChatMessageAction(options: SendChatMessageActionOptions): Promise<void> {
  const text = options.input.trim();
  if (!text || !options.selectedAgent || options.isSending) {
    return;
  }

  options.setIsSending(true);

  const existing = options.getMessages(options.selectedAgentId);
  const { clientActionId, assistantMessageId, messages } = createOptimisticChatExchange({
    text,
    existing,
    uid: options.uid,
    now: options.nowTime,
    createClientActionId: options.createClientActionId,
  });
  options.upsertMessages(options.selectedAgentId, messages);
  options.setInput("");

  try {
    await options.streamChat(
      {
        user_id: options.userId,
        message: text,
        agent_id: options.selectedAgentId,
        domain_id: options.activeDomainId,
        client_action_id: clientActionId,
      },
      {
        onDelta: (content) => {
          const rows = options.getMessages(options.selectedAgentId);
          options.upsertMessages(options.selectedAgentId, appendAssistantDelta(rows, assistantMessageId, content));
        },
        onDone: (event) => {
          const rows = options.getMessages(options.selectedAgentId);
          options.upsertMessages(options.selectedAgentId, finishAssistantStreaming(rows, assistantMessageId));

          const previous = options.getLiveState(options.selectedAgentId);
          options.setLiveState(
            options.selectedAgentId,
            createLiveStateFromChatDone({
              event,
              previous,
              now: options.nowIso,
            }),
          );
        },
      },
    );
  } catch (error) {
    const message = `聊天请求失败: ${getErrorMessage(error)}`;
    options.setFatalError(message);
    options.setNotice(message);
    throw error;
  } finally {
    options.setIsSending(false);
  }
}

export function useChatSending(options: UseChatSendingOptions) {
  const [isSending, setIsSending] = useState<boolean>(false);
  const setLiveState = useChatStore((state) => state.setLiveState);
  const upsertMessages = useChatStore((state) => state.upsertMessages);

  const sendMessage = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      await sendChatMessageAction({
        input: options.input,
        selectedAgent: options.selectedAgent,
        selectedAgentId: options.selectedAgentId,
        isSending,
        userId: options.userId,
        activeDomainId: options.activeDomainId,
        uid: options.uid,
        nowTime: options.nowTime,
        createClientActionId: () => crypto.randomUUID(),
        nowIso: () => new Date().toISOString(),
        streamChat,
        getMessages: (agentId) => useChatStore.getState().messagesByAgent[agentId] ?? [],
        getLiveState: (agentId) => useChatStore.getState().liveStateByAgent[agentId],
        upsertMessages,
        setLiveState,
        setInput: options.setInput,
        setIsSending,
        setFatalError: options.setFatalError,
        setNotice: options.setNotice,
      });
    },
    [
      isSending,
      options.activeDomainId,
      options.input,
      options.nowTime,
      options.selectedAgent,
      options.selectedAgentId,
      options.setFatalError,
      options.setInput,
      options.setNotice,
      options.uid,
      options.userId,
      setLiveState,
      upsertMessages,
    ],
  );

  return {
    isSending,
    sendMessage,
  };
}
