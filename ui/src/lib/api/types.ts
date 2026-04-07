export interface ChatRequestDto {
  user_id: string;
  message: string;
  conversation_id?: string;
  agent_id: string;
}

export interface ChatDeltaEvent {
  type: "delta";
  content: string;
}

export interface ChatDoneEvent {
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

export interface AgentLiveStateDto {
  agent_id: string;
  agent_name: string;
  mood_label: string;
  mood_intensity: number;
  mood_index: number;
  heartbeat_bpm: number;
  heartbeat_interval_ms: number;
  stress_level: number;
  trend: "up" | "down" | "steady";
  risk_level: string;
  updated_at: string;
}

export interface ConversationTurnDto {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export type ChatStreamEvent = ChatDeltaEvent | ChatDoneEvent;

export interface AgentResponseDto {
  id: string;
  name: string;
  display_name: string;
  persona: string;
  background: string;
  hobbies: string[];
  speaking_style: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export interface AgentCreateRequestDto {
  name: string;
  persona: string;
  background: string;
  hobbies: string[];
  speaking_style: string;
}

export interface AgentAICreateResponseDto {
  agent: AgentResponseDto;
  backend: string;
  model: string;
  used_prompt: string;
  raw_text: string;
}

export interface MemoryResponseDto {
  id: string;
  user_id: string;
  agent_id: string;
  memory_type: string;
  content: string;
  confidence: number;
  importance: number;
  status: "active" | "frozen" | "deleted";
  created_at: string;
}

export interface MemoryStatusRequestDto {
  user_id: string;
  agent_id: string;
}

export interface HeartbeatRequestDto {
  session_id: string;
  page: string;
  mode: string;
  user_id?: string;
  app_version?: string;
}

export interface FrontendErrorRequestDto {
  message: string;
  page: string;
  source?: string;
  stack?: string;
  app_version?: string;
  user_id?: string;
}

export interface WebVitalRequestDto {
  name: string;
  value: number;
  rating?: string;
  page: string;
  metric_id?: string;
  app_version?: string;
}
