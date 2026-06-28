export interface ChatRequestDto {
  readonly user_id: string;
  readonly message: string;
  readonly conversation_id?: string;
  readonly agent_id: string;
  readonly domain_id?: string;
  readonly client_action_id?: string;
}

export interface ChatDeltaEvent {
  readonly type: "delta";
  readonly content: string;
}

export interface ChatDoneEvent {
  readonly type: "done";
  readonly agent_id: string;
  readonly agent_name: string;
  readonly emotion_label: string;
  readonly mood_intensity: number;
  readonly heartbeat_bpm: number;
  readonly risk_level: string;
  readonly recalled_memories: ReadonlyArray<Readonly<{ memory_type: string; content: string }>>;
  readonly persisted_memory_count: number;
}

export interface AgentLiveStateDto {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly mood_label: string;
  readonly mood_intensity: number;
  readonly mood_index: number;
  readonly heartbeat_bpm: number;
  readonly heartbeat_interval_ms: number;
  readonly stress_level: number;
  readonly trend: "up" | "down" | "steady";
  readonly risk_level: string;
  readonly updated_at: string;
}

export interface ConversationTurnDto {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly created_at: string;
}

export interface PostItemDto {
  readonly id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly agent_name: string;
  readonly content: string;
  readonly topic_seed: string;
  readonly post_type: "status" | "reflection" | "plan";
  readonly status: "published" | "archived";
  readonly source_task_id: string | null;
  readonly created_at: string;
}

export interface PostListDto {
  readonly items: ReadonlyArray<PostItemDto>;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface GeneratePostRequestDto {
  readonly user_id: string;
  readonly source_task_id?: string | null;
}

export interface GeneratePostResponseDto {
  readonly skipped: boolean;
  readonly reason: string;
  readonly post: PostItemDto | null;
}

export interface TriggerChatFromPostDto {
  readonly post_id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly suggested_message: string;
}

export interface InfraTargetStatusDto {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly detail: string;
}

export interface InfraDebugDto {
  readonly memory_repository: string;
  readonly memory_vector: string;
  readonly emotion_backend: string;
  readonly emotion_model: string;
  readonly postgres: InfraTargetStatusDto;
  readonly qdrant: InfraTargetStatusDto;
}

export interface AgentMemorySeedDebugRequestDto {
  readonly dry_run?: boolean;
  readonly force_reextract?: boolean;
}

export interface AgentMemorySeedDebugResponseDto {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly dry_run: boolean;
  readonly force_reextract: boolean;
  readonly skipped_existing: boolean;
  readonly existing_count: number;
  readonly used_fallback: boolean;
  readonly extraction_backend: string;
  readonly extraction_model: string;
  readonly extraction_is_llm: boolean;
  readonly extraction_reason: string;
  readonly raw_text: string;
  readonly candidate_count: number;
  readonly persisted_count: number;
}

export type ChatStreamEvent = ChatDeltaEvent | ChatDoneEvent;

export interface AgentResponseDto {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly greeting: string;
  readonly persona: string;
  readonly background: string;
  readonly domain_id: string;
  readonly world_context: string;
  readonly hobbies: ReadonlyArray<string>;
  readonly speaking_style: string;
  readonly status: "active" | "inactive";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AgentCreateRequestDto {
  readonly name: string;
  readonly persona: string;
  readonly background: string;
  readonly domain_id?: string;
  readonly hobbies: ReadonlyArray<string>;
  readonly speaking_style: string;
}

export interface WorldSummaryDto {
  readonly id: string;
  readonly name: string;
}

export interface WorldDetailDto {
  readonly id: string;
  readonly name: string;
  readonly lore: string;
  readonly tone: string;
  readonly constraints: ReadonlyArray<string>;
  readonly seed_memories: ReadonlyArray<string>;
}

export interface WorldUpsertRequestDto {
  readonly id?: string;
  readonly name: string;
  readonly lore: string;
  readonly tone: string;
  readonly constraints: ReadonlyArray<string>;
  readonly seed_memories: ReadonlyArray<string>;
}

export interface WorldAICreateRequestDto {
  readonly prompt?: string;
  readonly world_id?: string;
  readonly base_domain_id?: string;
}

export interface WorldAICreateResponseDto {
  readonly world: WorldDetailDto;
  readonly backend: string;
  readonly model: string;
  readonly used_prompt: string;
  readonly raw_text: string;
}

export interface WorldDebugDto {
  readonly enabled: boolean;
  readonly default_domain_id: string;
  readonly active_domain_id: string;
  readonly active_domain_name: string;
  readonly summaries: ReadonlyArray<WorldSummaryDto>;
}

export interface AgentAICreateResponseDto {
  readonly agent: AgentResponseDto;
  readonly backend: string;
  readonly model: string;
  readonly used_prompt: string;
  readonly raw_text: string;
}

export interface MemoryResponseDto {
  readonly id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly domain_id: string;
  readonly subject: string;
  readonly memory_type: string;
  readonly content: string;
  readonly confidence: number;
  readonly importance: number;
  readonly status: "active" | "frozen" | "deleted";
  readonly conflict_state: string;
  readonly created_at: string;
  readonly access_count: number;
  readonly last_accessed_at: string | null;
}

export interface MemoryStatusRequestDto {
  readonly user_id: string;
  readonly agent_id: string;
  readonly domain_id?: string;
}

export interface HeartbeatRequestDto {
  readonly session_id: string;
  readonly page: string;
  readonly mode: string;
  readonly user_id?: string;
  readonly app_version?: string;
}

export interface FrontendErrorRequestDto {
  readonly message: string;
  readonly page: string;
  readonly source?: string;
  readonly stack?: string;
  readonly app_version?: string;
  readonly user_id?: string;
}

export interface WebVitalRequestDto {
  readonly name: string;
  readonly value: number;
  readonly rating?: string;
  readonly page: string;
  readonly metric_id?: string;
  readonly app_version?: string;
}
