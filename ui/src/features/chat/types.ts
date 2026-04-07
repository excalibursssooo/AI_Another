export type AgentStatus = "active" | "inactive";

export type MemoryStatus = "active" | "frozen" | "deleted";

export type MemoryType =
  | "profile"
  | "preference"
  | "goal"
  | "relationship"
  | "emotional_pattern";

export type ChatRole = "user" | "assistant";

export interface AiAgent {
  id: string;
  name: string;
  persona: string;
  background: string;
  hobbies: string[];
  speakingStyle: string;
  status: AgentStatus;
  tagline: string;
  avatarColor: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  isStreaming?: boolean;
}

export interface MemoryRecord {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  createdAt: string;
}
