import { describe, expect, it } from "vitest";

import { createLiveStateFromChatDone } from "./liveState";
import type { AgentLiveStateDto, ChatDoneEvent } from "@/lib/api/types_api";

function doneEvent(overrides: Partial<ChatDoneEvent> = {}): ChatDoneEvent {
  return {
    type: "done",
    agent_id: "agent-1",
    agent_name: "小伴",
    emotion_label: "happy",
    mood_intensity: 0.72,
    heartbeat_bpm: 80,
    risk_level: "low",
    recalled_memories: [],
    persisted_memory_count: 0,
    ...overrides,
  };
}

describe("createLiveStateFromChatDone", () => {
  it("maps chat done fields into live state metrics", () => {
    const state = createLiveStateFromChatDone({
      event: doneEvent(),
      previous: undefined,
      now: () => "2026-07-01T01:02:03.000Z",
    });

    expect(state).toEqual({
      agent_id: "agent-1",
      agent_name: "小伴",
      mood_label: "happy",
      mood_intensity: 0.72,
      mood_index: 72,
      heartbeat_bpm: 80,
      heartbeat_interval_ms: 750,
      stress_level: 0.288,
      trend: "steady",
      risk_level: "low",
      updated_at: "2026-07-01T01:02:03.000Z",
    });
  });

  it("calculates trend against previous mood index with threshold", () => {
    const previous: AgentLiveStateDto = {
      agent_id: "agent-1",
      agent_name: "小伴",
      mood_label: "calm",
      mood_intensity: 0.3,
      mood_index: 80,
      heartbeat_bpm: 72,
      heartbeat_interval_ms: 833,
      stress_level: 0.12,
      trend: "steady",
      risk_level: "low",
      updated_at: "old",
    };

    expect(
      createLiveStateFromChatDone({
        event: doneEvent({ mood_intensity: 0.73 }),
        previous,
        now: () => "now",
      }).trend,
    ).toBe("down");
    expect(
      createLiveStateFromChatDone({
        event: doneEvent({ mood_intensity: 0.86 }),
        previous,
        now: () => "now",
      }).trend,
    ).toBe("up");
  });

  it("clamps mood and heartbeat derived metrics", () => {
    const state = createLiveStateFromChatDone({
      event: doneEvent({
        mood_intensity: 1.5,
        heartbeat_bpm: 0,
        risk_level: "high",
      }),
      previous: undefined,
      now: () => "now",
    });

    expect(state.mood_index).toBe(100);
    expect(state.heartbeat_interval_ms).toBe(60000);
    expect(state.stress_level).toBe(1);
  });
});
