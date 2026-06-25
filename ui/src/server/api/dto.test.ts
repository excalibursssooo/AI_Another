import { describe, expect, it } from "vitest";

import { toAgentResponseDto, toConversationTurnDto, toMemoryResponseDto } from "./dto";

describe("API DTO mapping", () => {
  it("maps agent records to the existing frontend agent DTO shape", () => {
    expect(
      toAgentResponseDto({
        id: "agent-default",
        name: "xiao-ban",
        displayName: "小伴",
        persona: "温和",
        background: "默认角色",
        greeting: "你好",
        speakingStyle: "自然",
        hobbies: ["聊天"],
        worldId: "default",
        status: "active",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
      }),
    ).toMatchObject({
      id: "agent-default",
      display_name: "小伴",
      domain_id: "default",
      world_context: "",
      speaking_style: "自然",
      status: "active",
    });
  });

  it("maps conversation turns with ISO timestamps", () => {
    expect(
      toConversationTurnDto({
        id: "msg-1",
        conversationId: "conv-1",
        role: "assistant",
        content: "你好",
        createdAt: 1_700_000_000_000,
      }),
    ).toEqual({
      role: "assistant",
      content: "你好",
      created_at: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it("maps memories to the existing memory DTO shape", () => {
    expect(
      toMemoryResponseDto({
        id: "mem-1",
        userId: "u001",
        agentId: "agent-default",
        worldId: "default",
        subject: "user",
        memoryType: "profile",
        content: "用户喜欢雨天",
        importance: 0.8,
        confidence: 0.9,
        status: "active",
        createdAt: 1_700_000_000_000,
        accessCount: 2,
        lastAccessedAt: null,
      }),
    ).toMatchObject({
      id: "mem-1",
      user_id: "u001",
      agent_id: "agent-default",
      domain_id: "default",
      memory_type: "profile",
      conflict_state: "none",
      access_count: 2,
      last_accessed_at: null,
    });
  });
});
