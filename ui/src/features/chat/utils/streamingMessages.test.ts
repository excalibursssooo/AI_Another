import { describe, expect, it } from "vitest";

import { appendAssistantDelta, finishAssistantStreaming } from "./streamingMessages";
import type { ChatMessage } from "@/features/chat/types";

const rows: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "你好",
    createdAt: "09:00",
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "你",
    createdAt: "09:00",
    isStreaming: true,
  },
];

describe("streamingMessages", () => {
  it("appends delta content to the streaming assistant message", () => {
    expect(appendAssistantDelta(rows, "assistant-1", "好")).toEqual([
      rows[0],
      {
        ...rows[1],
        content: "你好",
        isStreaming: true,
      },
    ]);
  });

  it("marks the assistant message as not streaming", () => {
    expect(finishAssistantStreaming(rows, "assistant-1")).toEqual([
      rows[0],
      {
        ...rows[1],
        isStreaming: false,
      },
    ]);
  });

  it("keeps rows unchanged when the assistant message is missing", () => {
    expect(appendAssistantDelta(rows, "missing", "好")).toEqual(rows);
    expect(finishAssistantStreaming(rows, "missing")).toEqual(rows);
  });
});
