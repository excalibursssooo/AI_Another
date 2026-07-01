import { httpDelete, httpGet, httpPost, httpPut, streamPost } from "@/lib/api/client";
import {
  AgentLiveStateDto,
  AgentAICreateResponseDto,
  AgentMemorySeedDebugRequestDto,
  AgentMemorySeedDebugResponseDto,
  AgentCreateRequestDto,
  AgentResponseDto,
  ChatDoneEvent,
  ChatRequestDto,
  ConversationTurnDto,
  GeneratePostRequestDto,
  GeneratePostResponseDto,
  InfraDebugDto,
  MemoryResponseDto,
  MemoryStatusRequestDto,
  PostListDto,
  TriggerChatFromPostDto,
  WorldAICreateRequestDto,
  WorldAICreateResponseDto,
  WorldDebugDto,
  WorldDetailDto,
  WorldUpsertRequestDto,
} from "@/lib/api/types_api";

export async function listAgents(includeInactive = false, domainId?: string): Promise<AgentResponseDto[]> {
  const params = new URLSearchParams();
  if (includeInactive) {
    params.set("include_inactive", "true");
  }
  if (domainId && domainId.trim()) {
    params.set("domain_id", domainId);
  }
  const query = params.toString();
  return httpGet<AgentResponseDto[]>(query ? `/agents?${query}` : "/agents");
}

export async function createAgent(payload: AgentCreateRequestDto): Promise<AgentResponseDto> {
  return httpPost<AgentCreateRequestDto, AgentResponseDto>("/agents", payload);
}

export async function createAgentByAi(userId: string, prompt?: string, domainId = "default"): Promise<AgentAICreateResponseDto> {
  return httpPost<{ user_id: string; prompt: string | null; domain_id: string }, AgentAICreateResponseDto>("/agents/ai-create", {
    user_id: userId,
    prompt: prompt?.trim() || null,
    domain_id: domainId,
  });
}

export async function deleteAgent(agentId: string): Promise<AgentResponseDto> {
  return httpDelete<Record<string, never>, AgentResponseDto>(`/agents/${agentId}`, {});
}

export async function listMemories(
  userId: string,
  agentId: string,
  status = "all",
  domainId = "default",
): Promise<MemoryResponseDto[]> {
  const query = new URLSearchParams({
    user_id: userId,
    agent_id: agentId,
    domain_id: domainId,
    status,
  }).toString();
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

export async function listPosts(
  userId: string,
  params?: { limit?: number; offset?: number; includeArchived?: boolean; domainId?: string; signal?: AbortSignal },
): Promise<PostListDto> {
  const queryParams = new URLSearchParams({
    user_id: userId,
    limit: String(params?.limit ?? 20),
    offset: String(params?.offset ?? 0),
    include_archived: String(Boolean(params?.includeArchived ?? false)),
  });
  if (params?.domainId?.trim()) {
    queryParams.set("domain_id", params.domainId.trim());
  }
  return httpGet<PostListDto>(`/posts?${queryParams.toString()}`, { signal: params?.signal });
}

export async function generatePost(agentId: string, payload: GeneratePostRequestDto): Promise<GeneratePostResponseDto> {
  return httpPost<GeneratePostRequestDto, GeneratePostResponseDto>(`/agents/${agentId}/generate-post`, payload);
}

export async function triggerChatFromPost(postId: string, userId: string, domainId?: string): Promise<TriggerChatFromPostDto> {
  const params = new URLSearchParams({ user_id: userId });
  if (domainId && domainId.trim()) {
    params.set("domain_id", domainId);
  }
  const query = params.toString();
  return httpPost<Record<string, never>, TriggerChatFromPostDto>(`/posts/${postId}/trigger-chat?${query}`, {});
}

export async function getInfraDebug(): Promise<InfraDebugDto> {
  return httpGet<InfraDebugDto>("/infra/debug");
}

export async function getWorldDebug(domainId?: string): Promise<WorldDebugDto> {
  const query = domainId ? `?domain_id=${encodeURIComponent(domainId)}` : "";
  return httpGet<WorldDebugDto>(`/world/debug${query}`);
}

export async function listWorlds(): Promise<WorldDetailDto[]> {
  return httpGet<WorldDetailDto[]>("/worlds");
}

export async function getWorld(domainId: string): Promise<WorldDetailDto> {
  return httpGet<WorldDetailDto>(`/worlds/${encodeURIComponent(domainId)}`);
}

export async function createWorld(payload: WorldUpsertRequestDto): Promise<WorldDetailDto> {
  return httpPost<WorldUpsertRequestDto, WorldDetailDto>("/worlds", payload);
}

export async function updateWorld(domainId: string, payload: WorldUpsertRequestDto): Promise<WorldDetailDto> {
  return httpPut<WorldUpsertRequestDto, WorldDetailDto>(`/worlds/${encodeURIComponent(domainId)}`, payload);
}

export async function createWorldByAi(payload: WorldAICreateRequestDto): Promise<WorldAICreateResponseDto> {
  return httpPost<WorldAICreateRequestDto, WorldAICreateResponseDto>("/worlds/ai-create", payload);
}

export async function debugAgentMemorySeed(
  agentId: string,
  payload: AgentMemorySeedDebugRequestDto,
): Promise<AgentMemorySeedDebugResponseDto> {
  return httpPost<AgentMemorySeedDebugRequestDto, AgentMemorySeedDebugResponseDto>(
    `/agents/${agentId}/memory-seed/debug`,
    payload,
  );
}
