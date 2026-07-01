import type { ChatMessage } from "@/features/chat/types";

export function appendAssistantDelta(
  rows: ReadonlyArray<ChatMessage>,
  assistantMessageId: string,
  content: string,
): ChatMessage[] {
  const target = rows.find((msg) => msg.id === assistantMessageId);
  if (!target) {
    return [...rows];
  }
  const nextContent = `${target.content}${content}`;
  return rows.map((msg) => (msg.id === assistantMessageId ? { ...msg, content: nextContent, isStreaming: true } : msg));
}

export function finishAssistantStreaming(rows: ReadonlyArray<ChatMessage>, assistantMessageId: string): ChatMessage[] {
  if (!rows.some((msg) => msg.id === assistantMessageId)) {
    return [...rows];
  }
  return rows.map((msg) => (msg.id === assistantMessageId ? { ...msg, isStreaming: false } : msg));
}
