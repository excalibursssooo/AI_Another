import { describe, expect, it } from "vitest";

import { createOptimisticChatExchange } from "./optimisticMessages";
import type { ChatMessage } from "@/features/chat/types";

describe("createOptimisticChatExchange", () => {
  it("appends a user message and streaming assistant placeholder", () => {
    const existing: ChatMessage[] = [
      {
        id: "existing-1",
        role: "assistant",
        content: "之前的回复",
        createdAt: "09:00",
      },
    ];
    const ids = ["msg-user", "msg-assistant"];
    const times = ["09:01", "09:02"];

    const result = createOptimisticChatExchange({
      text: "你好",
      existing,
      uid: () => ids.shift() ?? "missing-id",
      now: () => times.shift() ?? "missing-time",
      createClientActionId: () => "client-1",
    });

    expect(result.clientActionId).toBe("client-1");
    expect(result.assistantMessageId).toBe("msg-assistant");
    expect(result.messages).toEqual([
      existing[0],
      {
        id: "msg-user",
        clientActionId: "client-1",
        role: "user",
        content: "你好",
        createdAt: "09:01",
      },
      {
        id: "msg-assistant",
        role: "assistant",
        content: "",
        createdAt: "09:02",
        isStreaming: true,
      },
    ]);
  });
});
