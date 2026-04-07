import { httpDelete, httpGet, httpPost, streamPost } from "@/lib/api/client";
import {
  AgentLiveStateDto,
  AgentAICreateResponseDto,
  AgentCreateRequestDto,
  AgentResponseDto,
  ChatDoneEvent,
  ChatRequestDto,
  ConversationTurnDto,
  MemoryResponseDto,
  MemoryStatusRequestDto,
} from "@/lib/api/types";

export async function listAgents(includeInactive = false): Promise<AgentResponseDto[]> {
  const query = includeInactive ? "?include_inactive=true" : "";
  return httpGet<AgentResponseDto[]>(`/agents${query}`);
}

export async function createAgent(payload: AgentCreateRequestDto): Promise<AgentResponseDto> {
  return httpPost<AgentCreateRequestDto, AgentResponseDto>("/agents", payload);
}

export async function createAgentByAi(prompt?: string): Promise<AgentAICreateResponseDto> {
  return httpPost<{ prompt: string | null }, AgentAICreateResponseDto>("/agents/ai-create", {
    prompt: prompt?.trim() || null,
  });
}

export async function deleteAgent(agentId: string): Promise<AgentResponseDto> {
  return httpDelete<Record<string, never>, AgentResponseDto>(`/agents/${agentId}`, {});
}

export async function listMemories(userId: string, agentId: string, status = "all"): Promise<MemoryResponseDto[]> {
  const query = new URLSearchParams({ user_id: userId, agent_id: agentId, status }).toString();
  return httpGet<MemoryResponseDto[]>(`/memories?${query}`);
}

export async function freezeMemory(memoryId: string, payload: MemoryStatusRequestDto): Promise<MemoryResponseDto> {
  return httpPost<MemoryStatusRequestDto, MemoryResponseDto>(`/memories/${memoryId}/freeze`, payload);
}

export async function activateMemory(memoryId: string, payload: MemoryStatusRequestDto): Promise<MemoryResponseDto> {
  return httpPost<MemoryStatusRequestDto, MemoryResponseDto>(`/memories/${memoryId}/activate`, payload);
}

export async function deleteMemory(memoryId: string, payload: MemoryStatusRequestDto): Promise<MemoryResponseDto> {
  return httpDelete<MemoryStatusRequestDto, MemoryResponseDto>(`/memories/${memoryId}`, payload);
}

export async function streamChat(
  payload: ChatRequestDto,
  handlers: {
    onDelta: (content: string) => void;
    onDone: (event: ChatDoneEvent) => void;
  },
): Promise<void> {
  await streamPost("/chat", payload, (event) => {
    if (event.type === "delta" && typeof event.content === "string") {
      handlers.onDelta(event.content);
      return;
    }

    if (
      event.type === "done" &&
      typeof event.agent_id === "string" &&
      typeof event.agent_name === "string" &&
      typeof event.emotion_label === "string" &&
      typeof event.risk_level === "string" &&
      Array.isArray(event.recalled_memories) &&
      typeof event.persisted_memory_count === "number"
    ) {
      const doneEvent: ChatDoneEvent = {
        type: "done",
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        emotion_label: event.emotion_label,
        mood_intensity: typeof event.mood_intensity === "number" ? event.mood_intensity : 0.35,
        heartbeat_bpm: typeof event.heartbeat_bpm === "number" ? event.heartbeat_bpm : 72,
        risk_level: event.risk_level,
        recalled_memories: event.recalled_memories
          .filter(
            (item): item is { memory_type: string; content: string } =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as { memory_type?: unknown }).memory_type === "string" &&
              typeof (item as { content?: unknown }).content === "string",
          )
          .map((item) => ({ memory_type: item.memory_type, content: item.content })),
        persisted_memory_count: event.persisted_memory_count,
      };
      handlers.onDone(doneEvent);
    }
  });
}

export async function listConversationTurns(
  userId: string,
  agentId: string,
  limit = 100,
): Promise<ConversationTurnDto[]> {
  const query = new URLSearchParams({
    user_id: userId,
    agent_id: agentId,
    limit: String(limit),
  }).toString();
  return httpGet<ConversationTurnDto[]>(`/conversations?${query}`);
}

export async function getAgentLiveState(userId: string, agentId: string): Promise<AgentLiveStateDto> {
  const query = new URLSearchParams({ user_id: userId }).toString();
  return httpGet<AgentLiveStateDto>(`/agents/${agentId}/state/live?${query}`);
}
