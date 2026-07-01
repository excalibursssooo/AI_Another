import type { AgentLiveStateDto, ChatDoneEvent } from "@/lib/api/types_api";

interface CreateLiveStateFromChatDoneInput {
  event: ChatDoneEvent;
  previous?: AgentLiveStateDto;
  now: () => string;
}

export function createLiveStateFromChatDone(input: CreateLiveStateFromChatDoneInput): AgentLiveStateDto {
  const nextIndex = Math.round(Math.max(0, Math.min(1, input.event.mood_intensity)) * 100);
  const previousIndex = input.previous?.mood_index ?? nextIndex;
  const trend: AgentLiveStateDto["trend"] =
    nextIndex >= previousIndex + 6 ? "up" : nextIndex <= previousIndex - 6 ? "down" : "steady";

  return {
    agent_id: input.event.agent_id,
    agent_name: input.event.agent_name,
    mood_label: input.event.emotion_label,
    mood_intensity: input.event.mood_intensity,
    mood_index: nextIndex,
    heartbeat_bpm: input.event.heartbeat_bpm,
    heartbeat_interval_ms: Math.floor(60_000 / Math.max(1, input.event.heartbeat_bpm)),
    stress_level: Math.max(0, Math.min(1, input.event.mood_intensity * (input.event.risk_level === "low" ? 0.4 : 0.75))),
    trend,
    risk_level: input.event.risk_level,
    updated_at: input.now(),
  };
}
