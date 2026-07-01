import { describe, expect, it, vi } from "vitest";

import { sendChatMessageAction } from "./useChatSending";
import type { AgentLiveStateDto, ChatDoneEvent, ChatRequestDto } from "@/lib/api/types_api";
import type { AiAgent, ChatMessage } from "@/features/chat/types";

const agent: AiAgent = {
  id: "agent-1",
  name: "小伴",
  greeting: "你好",
  persona: "温和",
  background: "测试角色",
  domainId: "world-1",
  worldContext: "",
  hobbies: [],
  speakingStyle: "自然",
  status: "active",
  tagline: "温和",
  avatarColor: "#fff",
};

const doneEvent: ChatDoneEvent = {
  type: "done",
  agent_id: "agent-1",
  agent_name: "小伴",
  emotion_label: "calm",
  mood_intensity: 0.6,
  heartbeat_bpm: 75,
  risk_level: "low",
  recalled_memories: [],
  persisted_memory_count: 0,
};

describe("sendChatMessageAction", () => {
  it("returns without side effects when the message cannot be sent", async () => {
    const setIsSending = vi.fn();

    await sendChatMessageAction({
      input: "   ",
      selectedAgent: agent,
      selectedAgentId: "agent-1",
      isSending: false,
      userId: "u001",
      activeDomainId: "world-1",
      uid: vi.fn(),
      nowTime: vi.fn(),
      createClientActionId: vi.fn(),
      nowIso: vi.fn(),
      streamChat: vi.fn(),
      getMessages: vi.fn(),
      getLiveState: vi.fn(),
      upsertMessages: vi.fn(),
      setLiveState: vi.fn(),
      setInput: vi.fn(),
      setIsSending,
      setFatalError: vi.fn(),
      setNotice: vi.fn(),
    });

    expect(setIsSending).not.toHaveBeenCalled();
  });

  it("writes optimistic messages, streams deltas, and updates live state on done", async () => {
    const messagesByAgent: Record<string, ChatMessage[]> = {
      "agent-1": [
        {
          id: "existing-1",
          role: "assistant",
          content: "旧消息",
          createdAt: "08:59",
        },
      ],
    };
    const liveStateByAgent: Record<string, AgentLiveStateDto | undefined> = {};
    const isSending: boolean[] = [];
    const inputs: string[] = [];
    const ids = ["msg-user", "msg-assistant"];
    const times = ["09:00", "09:01"];
    let payload: ChatRequestDto | undefined;

    const streamChat = vi.fn(async (nextPayload: ChatRequestDto, handlers: Parameters<typeof sendChatMessageAction>[0]["streamChat"] extends (payload: ChatRequestDto, handlers: infer T) => Promise<void> ? T : never) => {
      payload = nextPayload;
      handlers.onDelta("你");
      handlers.onDelta("好");
      handlers.onDone(doneEvent);
    });

    await sendChatMessageAction({
      input: "  你好  ",
      selectedAgent: agent,
      selectedAgentId: "agent-1",
      isSending: false,
      userId: "u001",
      activeDomainId: "world-1",
      uid: () => ids.shift() ?? "missing-id",
      nowTime: () => times.shift() ?? "missing-time",
      createClientActionId: () => "client-1",
      nowIso: () => "2026-07-01T00:00:00.000Z",
      streamChat,
      getMessages: (agentId) => messagesByAgent[agentId] ?? [],
      getLiveState: (agentId) => liveStateByAgent[agentId],
      upsertMessages: (agentId, messages) => {
        messagesByAgent[agentId] = messages;
      },
      setLiveState: (agentId, state) => {
        liveStateByAgent[agentId] = state;
      },
      setInput: (value) => inputs.push(value),
      setIsSending: (value) => isSending.push(value),
      setFatalError: vi.fn(),
      setNotice: vi.fn(),
    });

    expect(payload).toEqual({
      user_id: "u001",
      message: "你好",
      conversation_id: "agent-1",
      agent_id: "agent-1",
      domain_id: "world-1",
      client_action_id: "client-1",
    });
    expect(messagesByAgent["agent-1"]).toEqual([
      {
        id: "existing-1",
        role: "assistant",
        content: "旧消息",
        createdAt: "08:59",
      },
      {
        id: "msg-user",
        clientActionId: "client-1",
        role: "user",
        content: "你好",
        createdAt: "09:00",
      },
      {
        id: "msg-assistant",
        role: "assistant",
        content: "你好",
        createdAt: "09:01",
        isStreaming: false,
      },
    ]);
    expect(liveStateByAgent["agent-1"]).toMatchObject({
      agent_id: "agent-1",
      mood_label: "calm",
      mood_index: 60,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    expect(inputs).toEqual([""]);
    expect(isSending).toEqual([true, false]);
  });

  it("reports and rethrows stream failures while clearing sending state", async () => {
    const fatalErrors: string[] = [];
    const notices: string[] = [];
    const isSending: boolean[] = [];

    await expect(
      sendChatMessageAction({
        input: "你好",
        selectedAgent: agent,
        selectedAgentId: "agent-1",
        isSending: false,
        userId: "u001",
        activeDomainId: "world-1",
        uid: () => "msg",
        nowTime: () => "09:00",
        createClientActionId: () => "client-1",
        nowIso: () => "2026-07-01T00:00:00.000Z",
        streamChat: vi.fn(async () => {
          throw new Error("network down");
        }),
        getMessages: () => [],
        getLiveState: () => undefined,
        upsertMessages: vi.fn(),
        setLiveState: vi.fn(),
        setInput: vi.fn(),
        setIsSending: (value) => isSending.push(value),
        setFatalError: (message) => fatalErrors.push(message),
        setNotice: (message) => notices.push(message),
      }),
    ).rejects.toThrow("network down");

    expect(fatalErrors).toEqual(["聊天请求失败: network down"]);
    expect(notices).toEqual(["聊天请求失败: network down"]);
    expect(isSending).toEqual([true, false]);
  });
});
