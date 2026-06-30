interface FinalizeAgent {
  displayName?: string;
  name?: string;
}

interface FinalizeMemory {
  memoryType: string;
  content: string;
}

export interface ChatDoneEventPayload {
  type: "done";
  agent_id: string;
  agent_name: string;
  emotion_label: string;
  mood_intensity: number;
  heartbeat_bpm: number;
  risk_level: string;
  recalled_memories: Array<{ memory_type: string; content: string }>;
  persisted_memory_count: number;
}

interface FinalizeChatContext {
  agentId: string;
  agent?: FinalizeAgent;
  mood?: { label: string; intensity: number; heartbeatBpm: number };
  riskLevel?: "low" | "medium" | "high";
  recalledMemories?: FinalizeMemory[];
  persistedMemoryCount?: number;
}

export function finalizeChatContext<TContext extends FinalizeChatContext>(
  ctx: TContext,
): TContext & { doneEvent: ChatDoneEventPayload } {
  const agentName = ctx.agent?.displayName || ctx.agent?.name || ctx.agentId;
  return {
    ...ctx,
    doneEvent: {
      type: "done",
      agent_id: ctx.agentId,
      agent_name: agentName,
      emotion_label: ctx.mood?.label ?? "neutral",
      mood_intensity: ctx.mood?.intensity ?? 0.35,
      heartbeat_bpm: ctx.mood?.heartbeatBpm ?? 72,
      risk_level: ctx.riskLevel ?? "low",
      recalled_memories: (ctx.recalledMemories ?? []).map((item) => ({
        memory_type: item.memoryType,
        content: item.content,
      })),
      persisted_memory_count: ctx.persistedMemoryCount ?? 0,
    },
  };
}
