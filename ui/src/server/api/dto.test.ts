import { describe, expect, it } from "vitest";

import { toAgentResponseDto, toConversationTurnDto, toMemoryResponseDto, toPostItemDto } from "./dto";

describe("API DTO mapping", () => {
  it("maps agent records to the existing frontend agent DTO shape", () => {
    expect(
      toAgentResponseDto(
        {
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
        },
        { id: "w", name: "海风镇", lore: "南方", tone: "潮湿", constraints: [], seedMemories: ["记忆1", "记忆2"] },
      ),
    ).toMatchObject({
      id: "agent-default",
      display_name: "小伴",
      domain_id: "default",
      world_context: "南方\n潮湿\n记忆1\n记忆2",
      speaking_style: "自然",
      status: "active",
    });
  });

  it("with world: toAgentResponseDto returns world_context containing all world parts joined", () => {
    const result = toAgentResponseDto(
      { id: "a1", name: "n", displayName: "n", persona: "p", background: "b", greeting: "g", speakingStyle: "s", hobbies: [], worldId: "w1", status: "active", createdAt: 1, updatedAt: 1 },
      { id: "w", name: "海风镇", lore: "南方", tone: "潮湿", constraints: [], seedMemories: ["记忆1", "记忆2"] },
    );
    expect(result.world_context).toContain("南方");
    expect(result.world_context).toContain("潮湿");
    expect(result.world_context).toContain("记忆1");
    expect(result.world_context).toContain("记忆2");
  });

  it("without world: toAgentResponseDto returns world_context as empty string", () => {
    const result = toAgentResponseDto({
      id: "a1",
      name: "n",
      displayName: "n",
      persona: "p",
      background: "b",
      greeting: "g",
      speakingStyle: "s",
      hobbies: [],
      worldId: "w1",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.world_context).toBe("");
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

  it("maps feed posts to the frontend post DTO shape", () => {
    expect(
      toPostItemDto({
        id: "post-1",
        userId: "u001",
        agentId: "agent-default",
        agentName: "小伴",
        worldId: "default",
        content: "今天想把一件小事讲给你听。",
        topicSeed: "一件小事",
        postType: "status",
        status: "published",
        sourceTaskId: null,
        createdAt: 1_700_000_000_000,
      }),
    ).toMatchObject({
      id: "post-1",
      user_id: "u001",
      agent_id: "agent-default",
      agent_name: "小伴",
      topic_seed: "一件小事",
      post_type: "status",
      status: "published",
      source_task_id: null,
      created_at: new Date(1_700_000_000_000).toISOString(),
    });
  });
});
