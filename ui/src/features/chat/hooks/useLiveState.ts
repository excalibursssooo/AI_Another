import { useEffect, useMemo, useRef } from "react";

import { getAgentLiveState } from "@/lib/api/companion";
import { AiAgent } from "@/features/chat/types";
import { DEFAULT_VITALS, POLL_INTERVALS } from "@/config/constants";
import { useChatStore } from "@/stores/useChatStore";
import { calculateVitalsJitter } from "@/features/chat/utils/vitals";

interface UseLiveStateOptions {
  userId: string;
  selectedAgent: AiAgent | undefined;
}

export function useLiveState(options: UseLiveStateOptions) {
  const liveStateByAgent = useChatStore((state) => state.liveStateByAgent);
  const setLiveState = useChatStore((state) => state.setLiveState);
  const vitalsContainerRef = useRef<HTMLDivElement>(null);

  const selectedLiveState = useMemo(
    () => (options.selectedAgent ? liveStateByAgent[options.selectedAgent.id] : undefined),
    [liveStateByAgent, options.selectedAgent],
  );
  const baseHeartbeatBpm = selectedLiveState?.heartbeat_bpm ?? DEFAULT_VITALS.HEARTBEAT;
  const baseStressLevel = selectedLiveState?.stress_level ?? DEFAULT_VITALS.STRESS;
  const baseMoodIndex = selectedLiveState?.mood_index ?? DEFAULT_VITALS.MOOD;

  useEffect(() => {
    const selectedAgent = options.selectedAgent;
    if (!selectedAgent) {
      return;
    }

    let disposed = false;
    const load = async () => {
      try {
        const state = await getAgentLiveState(options.userId, selectedAgent.id);
        if (!disposed) {
          setLiveState(selectedAgent.id, state);
        }
      } catch {
        // Keep previous state if polling fails.
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVALS.AGENT_LIVE_STATE);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [options.selectedAgent, options.userId, setLiveState]);

  useEffect(() => {
    let animationFrameId = 0;
    const renderJitter = () => {
      const container = vitalsContainerRef.current;
      if (container) {
        const t = Date.now() / 1000;
        const next = calculateVitalsJitter(
          {
            heartbeat: baseHeartbeatBpm,
            stress: baseStressLevel,
            mood: baseMoodIndex,
          },
          t,
        );

        container.style.setProperty("--current-bpm", String(next.heartbeat));
        container.style.setProperty("--current-stress", String(next.stress));
        container.style.setProperty("--current-mood", String(next.mood));
      }

      animationFrameId = requestAnimationFrame(renderJitter);
    };

    animationFrameId = requestAnimationFrame(renderJitter);

    return () => cancelAnimationFrame(animationFrameId);
  }, [baseHeartbeatBpm, baseMoodIndex, baseStressLevel]);

  return {
    selectedLiveState,
    displayHeartbeatBpm: baseHeartbeatBpm,
    displayStressLevel: baseStressLevel,
    displayMoodIndex: baseMoodIndex,
    vitalsContainerRef,
  };
}
