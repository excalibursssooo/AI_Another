import { useCallback, useState } from "react";

import { ANIMATION_DELAYS } from "@/config/constants";
import { createAgent, createAgentByAi } from "@/lib/api/companion";
import type { AgentAICreateResponseDto, AgentCreateRequestDto, AgentResponseDto, FrontendErrorRequestDto } from "@/lib/api/types_api";
import { reportFrontendError } from "@/lib/api/telemetry";
import { getErrorMessage } from "@/lib/utils/error";
import type { AiAgent } from "@/features/chat/types";
import { useCreationFlow } from "@/features/chat/hooks/useCreationFlow";

type CreationMode = "ai" | "manual";
type CreatingPlaceholder = { active: boolean; name: string };
type SetNotice = (message: string) => void;

interface CreationActionBase {
  selectedDomainId: string;
  agentsCount: number;
  userId: string;
  page: string;
  mapAgentFromApi: (item: AgentResponseDto, index: number) => AiAgent;
  prependAgentWithGreeting: (agent: AiAgent) => void;
  runSeedAndInfraStages: (agentId: string, mode: CreationMode) => Promise<void>;
  startFlow: (mode: CreationMode, message: string) => void;
  pushLog: (line: string) => void;
  completeFlow: (signature: string, nextMessage: string) => Promise<void>;
  failFlow: (errorMessage: string) => Promise<void>;
  reportFrontendError: (payload: FrontendErrorRequestDto) => Promise<void>;
  setCreatingPlaceholder: (value: CreatingPlaceholder) => void;
  setShowAddFriendMenu: (value: boolean) => void;
  setNotice: SetNotice;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minWaitMs: number;
}

interface CreateManualAgentActionOptions extends CreationActionBase {
  draftName: string;
  draftPersona: string;
  draftStyle: string;
  createAgent: (payload: AgentCreateRequestDto) => Promise<AgentResponseDto>;
  setDraftName: (value: string) => void;
  setDraftPersona: (value: string) => void;
  setDraftStyle: (value: string) => void;
  setShowCustomCreateForm: (value: boolean) => void;
}

interface CreateAiAgentActionOptions extends CreationActionBase {
  createAgentByAi: (prompt?: string, domainId?: string) => Promise<AgentAICreateResponseDto>;
  setRestructuringPhase: (message: string) => void;
}

interface UseAgentCreationOptions {
  selectedDomainId: string;
  agentsCount: number;
  userId: string;
  draftName: string;
  draftPersona: string;
  draftStyle: string;
  mapAgentFromApi: (item: AgentResponseDto, index: number) => AiAgent;
  prependAgentWithGreeting: (agent: AiAgent) => void;
  setDraftName: (value: string) => void;
  setDraftPersona: (value: string) => void;
  setDraftStyle: (value: string) => void;
  setShowCustomCreateForm: (value: boolean) => void;
  setShowAddFriendMenu: (value: boolean) => void;
  onNotice: SetNotice;
}

async function waitForMinimumDuration(input: { startedAt: number; now: () => number; sleep: (ms: number) => Promise<void>; minWaitMs: number }) {
  const elapsed = input.now() - input.startedAt;
  if (elapsed < input.minWaitMs) {
    await input.sleep(input.minWaitMs - elapsed);
  }
}

export async function createManualAgentAction(options: CreateManualAgentActionOptions): Promise<void> {
  const name = options.draftName.trim();
  if (!name) {
    return;
  }

  const flowStart = options.now();
  options.setCreatingPlaceholder({ active: true, name: `${name} (构建中)` });
  options.startFlow("manual", "记忆灌注引擎启动中...");
  options.pushLog("[System] Parsing manual profile payload...");

  try {
    const created = await options.createAgent({
      name,
      persona: options.draftPersona.trim() || "温暖、稳定、会倾听",
      background: "由你在前端创建的 AI 联系人。",
      domain_id: options.selectedDomainId,
      hobbies: ["散步", "音乐"],
      speaking_style: options.draftStyle.trim() || "温柔有边界",
    });
    await options.runSeedAndInfraStages(created.id, "manual");
    await waitForMinimumDuration({
      startedAt: flowStart,
      now: options.now,
      sleep: options.sleep,
      minWaitMs: options.minWaitMs,
    });
    options.prependAgentWithGreeting(options.mapAgentFromApi(created, options.agentsCount));
    options.setDraftName("");
    options.setDraftPersona("");
    options.setDraftStyle("");
    options.setShowCustomCreateForm(false);
    options.setShowAddFriendMenu(false);
    options.setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    await options.completeFlow(created.name, "神经连接稳定，角色上线。");
    options.setNotice("角色创建成功");
  } catch (error) {
    options.setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    const message = getErrorMessage(error);
    await options.failFlow(message);
    void options.reportFrontendError({
      message: `manual-create failed: ${message}`,
      page: options.page,
      source: "createAgentHandle",
      user_id: options.userId,
    });
    options.setNotice(`角色创建失败: ${message}`);
  }
}

export async function createAiAgentAction(options: CreateAiAgentActionOptions): Promise<void> {
  const flowStart = options.now();
  options.setCreatingPlaceholder({ active: true, name: "数字人格孵化中..." });
  options.startFlow("ai", "数字降生引擎启动中...");
  options.pushLog("[System] Retrieving shared-scope memory...");

  try {
    options.setRestructuringPhase("几何人格体重组中...");
    options.pushLog("[Kernel] Reassembling persona lattice...");
    const created = await options.createAgentByAi(undefined, options.selectedDomainId);
    await options.runSeedAndInfraStages(created.agent.id, "ai");
    await waitForMinimumDuration({
      startedAt: flowStart,
      now: options.now,
      sleep: options.sleep,
      minWaitMs: options.minWaitMs,
    });
    options.prependAgentWithGreeting(options.mapAgentFromApi(created.agent, options.agentsCount));
    options.setShowAddFriendMenu(false);
    options.setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    await options.completeFlow(created.agent.name, "数字人格已定型并接入会话链路。");
    options.setNotice(`AI 建角成功（${created.model}）`);
  } catch (error) {
    options.setCreatingPlaceholder({ active: false, name: "角色构建中..." });
    const message = getErrorMessage(error);
    await options.failFlow(message);
    void options.reportFrontendError({
      message: `ai-create failed: ${message}`,
      page: options.page,
      source: "aiCreateAgentHandle",
      user_id: options.userId,
    });
    options.setNotice(`AI 建角失败: ${message}`);
  }
}

export function useAgentCreation(options: UseAgentCreationOptions) {
  const [creatingPlaceholder, setCreatingPlaceholder] = useState<CreatingPlaceholder>({
    active: false,
    name: "角色构建中...",
  });
  const { overlay, startFlow, setRestructuringPhase, runSeedAndInfraStages, pushLog, completeFlow, failFlow } = useCreationFlow();

  const createAgentHandle = useCallback(async () => {
    await createManualAgentAction({
      draftName: options.draftName,
      draftPersona: options.draftPersona,
      draftStyle: options.draftStyle,
      selectedDomainId: options.selectedDomainId,
      agentsCount: options.agentsCount,
      userId: options.userId,
      page: window.location.pathname,
      createAgent,
      mapAgentFromApi: options.mapAgentFromApi,
      prependAgentWithGreeting: options.prependAgentWithGreeting,
      runSeedAndInfraStages,
      startFlow,
      pushLog,
      completeFlow,
      failFlow,
      reportFrontendError,
      setCreatingPlaceholder,
      setDraftName: options.setDraftName,
      setDraftPersona: options.setDraftPersona,
      setDraftStyle: options.setDraftStyle,
      setShowCustomCreateForm: options.setShowCustomCreateForm,
      setShowAddFriendMenu: options.setShowAddFriendMenu,
      setNotice: options.onNotice,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      minWaitMs: ANIMATION_DELAYS.CUSTOM_CREATION_MIN_WAIT,
    });
  }, [
    completeFlow,
    failFlow,
    options.agentsCount,
    options.draftName,
    options.draftPersona,
    options.draftStyle,
    options.mapAgentFromApi,
    options.onNotice,
    options.prependAgentWithGreeting,
    options.selectedDomainId,
    options.setDraftName,
    options.setDraftPersona,
    options.setDraftStyle,
    options.setShowAddFriendMenu,
    options.setShowCustomCreateForm,
    options.userId,
    pushLog,
    runSeedAndInfraStages,
    startFlow,
  ]);

  const aiCreateAgentHandle = useCallback(async () => {
    await createAiAgentAction({
      selectedDomainId: options.selectedDomainId,
      agentsCount: options.agentsCount,
      userId: options.userId,
      page: window.location.pathname,
      createAgentByAi,
      mapAgentFromApi: options.mapAgentFromApi,
      prependAgentWithGreeting: options.prependAgentWithGreeting,
      runSeedAndInfraStages,
      startFlow,
      setRestructuringPhase,
      pushLog,
      completeFlow,
      failFlow,
      reportFrontendError,
      setCreatingPlaceholder,
      setShowAddFriendMenu: options.setShowAddFriendMenu,
      setNotice: options.onNotice,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      minWaitMs: ANIMATION_DELAYS.AI_CREATION_MIN_WAIT,
    });
  }, [
    completeFlow,
    failFlow,
    options.agentsCount,
    options.mapAgentFromApi,
    options.onNotice,
    options.prependAgentWithGreeting,
    options.selectedDomainId,
    options.setShowAddFriendMenu,
    options.userId,
    pushLog,
    runSeedAndInfraStages,
    setRestructuringPhase,
    startFlow,
  ]);

  return {
    overlay,
    creatingPlaceholder,
    createAgentHandle,
    aiCreateAgentHandle,
  };
}
