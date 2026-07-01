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
  readonly id: string;
  readonly name: string;
  readonly greeting?: string;
  readonly persona: string;
  readonly background: string;
  readonly domainId?: string;
  readonly worldContext?: string;
  readonly hobbies: ReadonlyArray<string>;
  readonly speakingStyle: string;
  readonly status: AgentStatus;
  readonly tagline: string;
  readonly avatarColor: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly clientActionId?: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt: string;
  readonly isStreaming?: boolean;
}

export interface MemoryRecord {
  readonly id: string;
  readonly agentId: string;
  readonly memoryType: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly importance: number;
  readonly status: MemoryStatus;
  readonly createdAt: string;
}
