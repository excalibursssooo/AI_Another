import type { AppDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { ConversationRepository } from "@/server/domain/conversation/conversation-repository";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";
import { AgentLiveStateRepository } from "@/server/domain/live-state/agent-live-state-repository";
import { TaskRepository } from "@/server/domain/chat/task-repository";

export interface ChatFlowDependencies {
  agents: Pick<AgentRepository, "get">;
  worlds: Pick<WorldRepository, "get">;
  conversations: Pick<ConversationRepository, "ensureConversation" | "recentMessages" | "appendMessage">;
  memories: Pick<MemoryRepository, "recall">;
  liveStates: Pick<AgentLiveStateRepository, "upsert">;
  tasks: Pick<TaskRepository, "enqueue">;
}

export function createChatFlowDependencies(db: AppDatabase): ChatFlowDependencies {
  return {
    agents: new AgentRepository(db),
    worlds: new WorldRepository(db),
    conversations: new ConversationRepository(db),
    memories: new MemoryRepository(db),
    liveStates: new AgentLiveStateRepository(db),
    tasks: new TaskRepository(db),
  };
}
