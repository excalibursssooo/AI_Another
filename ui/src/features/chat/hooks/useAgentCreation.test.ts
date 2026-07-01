import { describe, expect, it, vi } from "vitest";

import { createAiAgentAction, createManualAgentAction } from "./useAgentCreation";
import type { AgentResponseDto } from "@/lib/api/types_api";
import type { AiAgent } from "@/features/chat/types";

function agentDto(overrides: Partial<AgentResponseDto> = {}): AgentResponseDto {
  return {
    id: "agent-1",
    name: "小伴",
    display_name: "小伴",
    greeting: "你好",
    persona: "温和",
    background: "背景",
    domain_id: "world-1",
    world_context: "",
    hobbies: [],
    speaking_style: "自然",
    status: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function aiAgent(): AiAgent {
  return {
    id: "agent-1",
    name: "小伴",
    greeting: "你好",
    persona: "温和",
    background: "背景",
    domainId: "world-1",
    worldContext: "",
    hobbies: [],
    speakingStyle: "自然",
    status: "active",
    tagline: "温和",
    avatarColor: "#fff",
  };
}

describe("agent creation actions", () => {
  it("does nothing when manual creation has no name", async () => {
    const createAgent = vi.fn();
    const setCreatingPlaceholder = vi.fn();

    await createManualAgentAction({
      draftName: "   ",
      draftPersona: "",
      draftStyle: "",
      selectedDomainId: "world-1",
      agentsCount: 2,
      userId: "u001",
      page: "/",
      createAgent,
      mapAgentFromApi: vi.fn(),
      prependAgentWithGreeting: vi.fn(),
      runSeedAndInfraStages: vi.fn(),
      startFlow: vi.fn(),
      pushLog: vi.fn(),
      completeFlow: vi.fn(),
      failFlow: vi.fn(),
      reportFrontendError: vi.fn(),
      setCreatingPlaceholder,
      setDraftName: vi.fn(),
      setDraftPersona: vi.fn(),
      setDraftStyle: vi.fn(),
      setShowCustomCreateForm: vi.fn(),
      setShowAddFriendMenu: vi.fn(),
      setNotice: vi.fn(),
      now: vi.fn(),
      sleep: vi.fn(),
      minWaitMs: 500,
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(setCreatingPlaceholder).not.toHaveBeenCalled();
  });

  it("creates a manual agent, waits for the minimum duration, and clears the form", async () => {
    const created = agentDto();
    const mapped = aiAgent();
    const placeholders: Array<{ active: boolean; name: string }> = [];
    const sleeps: number[] = [];
    const notices: string[] = [];
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_200);
    const createAgent = vi.fn(async () => created);
    const prependAgentWithGreeting = vi.fn();

    await createManualAgentAction({
      draftName: "  小伴  ",
      draftPersona: "  ",
      draftStyle: "  ",
      selectedDomainId: "world-1",
      agentsCount: 3,
      userId: "u001",
      page: "/chat",
      createAgent,
      mapAgentFromApi: () => mapped,
      prependAgentWithGreeting,
      runSeedAndInfraStages: vi.fn(),
      startFlow: vi.fn(),
      pushLog: vi.fn(),
      completeFlow: vi.fn(),
      failFlow: vi.fn(),
      reportFrontendError: vi.fn(),
      setCreatingPlaceholder: (value) => placeholders.push(value),
      setDraftName: vi.fn(),
      setDraftPersona: vi.fn(),
      setDraftStyle: vi.fn(),
      setShowCustomCreateForm: vi.fn(),
      setShowAddFriendMenu: vi.fn(),
      setNotice: (message) => notices.push(message),
      now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      minWaitMs: 500,
    });

    expect(createAgent).toHaveBeenCalledWith({
      name: "小伴",
      persona: "温暖、稳定、会倾听",
      background: "由你在前端创建的 AI 联系人。",
      domain_id: "world-1",
      hobbies: ["散步", "音乐"],
      speaking_style: "温柔有边界",
    });
    expect(sleeps).toEqual([300]);
    expect(prependAgentWithGreeting).toHaveBeenCalledWith(mapped);
    expect(placeholders).toEqual([
      { active: true, name: "小伴 (构建中)" },
      { active: false, name: "角色构建中..." },
    ]);
    expect(notices).toEqual(["角色创建成功"]);
  });

  it("reports AI creation failures", async () => {
    const placeholders: Array<{ active: boolean; name: string }> = [];
    const reports: Array<{ message: string; page: string; source: string; user_id: string }> = [];
    const notices: string[] = [];

    await createAiAgentAction({
      selectedDomainId: "world-1",
      agentsCount: 3,
      userId: "u001",
      page: "/chat",
      createAgentByAi: vi.fn(async () => {
        throw new Error("model down");
      }),
      mapAgentFromApi: vi.fn(),
      prependAgentWithGreeting: vi.fn(),
      runSeedAndInfraStages: vi.fn(),
      startFlow: vi.fn(),
      setRestructuringPhase: vi.fn(),
      pushLog: vi.fn(),
      completeFlow: vi.fn(),
      failFlow: vi.fn(),
      reportFrontendError: (payload) => {
        reports.push(payload);
        return Promise.resolve();
      },
      setCreatingPlaceholder: (value) => placeholders.push(value),
      setShowAddFriendMenu: vi.fn(),
      setNotice: (message) => notices.push(message),
      now: vi.fn().mockReturnValue(1_000),
      sleep: vi.fn(),
      minWaitMs: 500,
    });

    expect(placeholders).toEqual([
      { active: true, name: "数字人格孵化中..." },
      { active: false, name: "角色构建中..." },
    ]);
    expect(reports).toEqual([
      {
        message: "ai-create failed: model down",
        page: "/chat",
        source: "aiCreateAgentHandle",
        user_id: "u001",
      },
    ]);
    expect(notices).toEqual(["AI 建角失败: model down"]);
  });
});
