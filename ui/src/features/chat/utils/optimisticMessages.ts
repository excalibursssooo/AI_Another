import type { ChatMessage } from "@/features/chat/types";

interface CreateOptimisticChatExchangeInput {
  text: string;
  existing: ReadonlyArray<ChatMessage>;
  uid: (prefix: string) => string;
  now: () => string;
  createClientActionId: () => string;
}

interface OptimisticChatExchange {
  clientActionId: string;
  assistantMessageId: string;
  messages: ChatMessage[];
}

export function createOptimisticChatExchange(input: CreateOptimisticChatExchangeInput): OptimisticChatExchange {
  const clientActionId = input.createClientActionId();
  const userMessage: ChatMessage = {
    id: input.uid("msg"),
    clientActionId,
    role: "user",
    content: input.text,
    createdAt: input.now(),
  };
  const assistantMessageId = input.uid("msg");

  return {
    clientActionId,
    assistantMessageId,
    messages: [
      ...input.existing,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: input.now(),
        isStreaming: true,
      },
    ],
  };
}
