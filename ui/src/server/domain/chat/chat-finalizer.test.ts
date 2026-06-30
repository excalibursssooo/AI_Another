import { describe, expect, it } from "vitest";

import { finalizeChatContext } from "./chat-finalizer";

describe("finalizeChatContext", () => {
  it("builds the done event DTO from chat context", () => {
    const result = finalizeChatContext({
      agentId: "agent-1",
      agent: { displayName: "林夏", name: "linxia" },
      mood: { label: "calm", intensity: 0.4, heartbeatBpm: 76 },
      riskLevel: "medium",
      recalledMemories: [{ memoryType: "preference", content: "用户喜欢雨天散步" }],
      persistedMemoryCount: 2,
    });

    expect(result.doneEvent).toEqual({
      type: "done",
      agent_id: "agent-1",
      agent_name: "林夏",
      emotion_label: "calm",
      mood_intensity: 0.4,
      heartbeat_bpm: 76,
      risk_level: "medium",
      recalled_memories: [{ memory_type: "preference", content: "用户喜欢雨天散步" }],
      persisted_memory_count: 2,
    });
  });
});
