import { useCallback, useState } from "react";

import { debugAgentMemorySeed, getInfraDebug } from "@/lib/api/companion";
import { ANIMATION_DELAYS } from "@/config/constants";
import { CreationOverlayState } from "@/features/chat/components/CreationOverlay";
import { getErrorMessage } from "@/lib/utils/error";

type CreationMode = "ai" | "manual";

interface UseCreationFlowOptions {
  userId: string;
}

export function useCreationFlow(options: UseCreationFlowOptions) {
  const [overlay, setOverlay] = useState<CreationOverlayState>({
    active: false,
    mode: "ai",
    phase: "idle",
    progress: 0,
    logs: [],
    message: "",
    error: "",
    signature: "",
    memoryNodesLit: 0,
    exploding: false,
  });

  const pushLog = useCallback((line: string) => {
    setOverlay((prev) => ({
      ...prev,
      logs: [...prev.logs, line].slice(-6),
    }));
  }, []);

  const startFlow = useCallback((mode: CreationMode, message: string) => {
    setOverlay({
      active: true,
      mode,
      phase: mode === "ai" ? "parsing" : "memory",
      progress: 8,
      logs: ["[System] Booting persona forge kernel..."],
      message,
      error: "",
      signature: "",
      memoryNodesLit: 0,
      exploding: false,
    });
  }, []);

  const setRestructuringPhase = useCallback((message: string) => {
    setOverlay((prev) => ({
      ...prev,
      phase: "restructuring",
      progress: Math.max(prev.progress, 30),
      message,
    }));
  }, []);

  const runSeedAndInfraStages = useCallback(
    async (agentId: string, mode: CreationMode) => {
      setOverlay((prev) => ({
        ...prev,
        phase: mode === "manual" ? "memory" : "restructuring",
        progress: Math.max(prev.progress, mode === "manual" ? 32 : 38),
        message: mode === "manual" ? "正在初始化角色设定记忆..." : "人格拼接矩阵重组中...",
      }));
      pushLog("[Kernel] Injecting subject identifiers: user/agent...");

      let seededCount = 0;
      try {
        const seedResult = await debugAgentMemorySeed(agentId, {
          dry_run: false,
          force_reextract: false,
          user_id: options.userId,
        });
        seededCount = Math.max(seedResult.persisted_count, seedResult.candidate_count);
        setOverlay((prev) => ({
          ...prev,
          memoryNodesLit: Math.max(1, Math.min(8, seededCount)),
          progress: Math.max(prev.progress, 72),
        }));
        pushLog(`[System] memory-seed persisted=${seedResult.persisted_count}`);
      } catch (error) {
        pushLog(`[System] memory-seed skipped: ${getErrorMessage(error)}`);
      }

      setOverlay((prev) => ({
        ...prev,
        phase: "diagnose",
        progress: Math.max(prev.progress, 82),
        message: "正在进行基础设施诊断...",
      }));
      pushLog("[System] Retrieving shared-scope memory...");
      try {
        const infra = await getInfraDebug();
        pushLog(
          `[Ready] infra postgres=${infra.postgres.reachable ? "ok" : "down"}, qdrant=${infra.qdrant.reachable ? "ok" : "down"}`,
        );
      } catch (error) {
        pushLog(`[System] infra-check degraded: ${getErrorMessage(error)}`);
      }
    },
    [options.userId, pushLog],
  );

  const completeFlow = useCallback(async (signature: string, nextMessage: string) => {
    setOverlay((prev) => ({
      ...prev,
      phase: "complete",
      progress: 100,
      message: nextMessage,
      signature,
      exploding: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAYS.CREATION_COMPLETE));
    setOverlay((prev) => ({ ...prev, active: false, exploding: false }));
  }, []);

  const failFlow = useCallback(async (errorMessage: string) => {
    setOverlay((prev) => ({
      ...prev,
      phase: "error",
      progress: Math.max(prev.progress, 38),
      error: errorMessage,
      message: "创建失败，系统核心断裂。",
      logs: [...prev.logs, `[Error] ${errorMessage}`].slice(-6),
    }));
    await new Promise((resolve) => setTimeout(resolve, ANIMATION_DELAYS.CREATION_FAIL));
    setOverlay((prev) => ({ ...prev, active: false, exploding: false }));
  }, []);

  return {
    overlay,
    startFlow,
    setRestructuringPhase,
    runSeedAndInfraStages,
    pushLog,
    completeFlow,
    failFlow,
  };
}
