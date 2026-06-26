import {
  AgentLiveStateRecord,
  AgentRecord,
  ConversationMessageRecord,
  FeedPostRecord,
  MemoryRecord,
  WorldRecord,
} from "@/server/domain/chat/repositories";

export function toAgentResponseDto(agent: AgentRecord, world?: WorldRecord | null) {
  const world_context = world
    ? [world.lore, world.tone, ...world.seedMemories]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .join("\n")
    : "";
  return {
    id: agent.id,
    name: agent.name,
    display_name: agent.displayName,
    greeting: agent.greeting,
    persona: agent.persona,
    background: agent.background,
    domain_id: agent.worldId,
    world_context,
    hobbies: agent.hobbies,
    speaking_style: agent.speakingStyle,
    status: agent.status,
    created_at: new Date(agent.createdAt).toISOString(),
    updated_at: new Date(agent.updatedAt).toISOString(),
  };
}

export function toWorldDetailDto(world: WorldRecord) {
  return {
    id: world.id,
    name: world.name,
    lore: world.lore,
    tone: world.tone,
    constraints: world.constraints,
    seed_memories: world.seedMemories,
  };
}

export function toConversationTurnDto(message: ConversationMessageRecord) {
  return {
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.content,
    created_at: new Date(message.createdAt).toISOString(),
  };
}

export function toMemoryResponseDto(memory: MemoryRecord) {
  return {
    id: memory.id,
    user_id: memory.userId,
    agent_id: memory.agentId,
    domain_id: memory.worldId,
    subject: memory.subject,
    memory_type: memory.memoryType,
    content: memory.content,
    confidence: memory.confidence,
    importance: memory.importance,
    status: memory.status,
    conflict_state: "none",
    created_at: new Date(memory.createdAt).toISOString(),
    access_count: memory.accessCount,
    last_accessed_at: memory.lastAccessedAt ? new Date(memory.lastAccessedAt).toISOString() : null,
  };
}

export function toAgentLiveStateDto(state: AgentLiveStateRecord) {
  const moodIndex = Math.round(Math.max(0, Math.min(1, state.moodIntensity)) * 100);
  return {
    agent_id: state.agentId,
    agent_name: state.agentName,
    mood_label: state.moodLabel,
    mood_intensity: state.moodIntensity,
    mood_index: moodIndex,
    heartbeat_bpm: state.heartbeatBpm,
    heartbeat_interval_ms: Math.floor(60_000 / Math.max(1, state.heartbeatBpm)),
    stress_level: Math.max(0, Math.min(1, state.moodIntensity * (state.riskLevel === "low" ? 0.4 : 0.75))),
    trend: "steady" as const,
    risk_level: state.riskLevel,
    updated_at: new Date(state.updatedAt).toISOString(),
  };
}

export function toPostItemDto(post: FeedPostRecord) {
  return {
    id: post.id,
    user_id: post.userId,
    agent_id: post.agentId,
    agent_name: post.agentName,
    content: post.content,
    topic_seed: post.topicSeed,
    post_type: post.postType,
    status: post.status,
    source_task_id: post.sourceTaskId,
    created_at: new Date(post.createdAt).toISOString(),
  };
}
