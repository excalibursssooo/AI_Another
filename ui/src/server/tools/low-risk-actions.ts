import { AppDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";

export interface ToolScope {
  db: AppDatabase;
  userId: string;
  agentId: string;
  worldId: string;
}

export function createLowRiskToolActions(scope: ToolScope) {
  const memories = new MemoryRepository(scope.db);

  return {
    searchMemories: async (input: { query: string; limit?: number }) =>
      memories
        .recall({
          userId: scope.userId,
          agentId: scope.agentId,
          worldId: scope.worldId,
          query: input.query,
          limit: Math.max(1, Math.min(10, input.limit ?? 5)),
        })
        .map((item) => ({
          memory_type: item.memoryType,
          content: item.content,
          importance: item.importance,
        })),

    createTaskDraft: async (input: { title: string; priority: "low" | "medium" | "high" }) => ({
      id: `draft-task-${Date.now()}`,
      status: "draft" as const,
      title: input.title.trim(),
      priority: input.priority,
      user_id: scope.userId,
      agent_id: scope.agentId,
    }),

    createFeedPostDraft: async (input: {
      content: string;
      topicSeed: string;
      postType: "status" | "reflection" | "plan";
    }) => ({
      id: `draft-post-${Date.now()}`,
      status: "draft" as const,
      user_id: scope.userId,
      agent_id: scope.agentId,
      domain_id: scope.worldId,
      content: input.content.trim(),
      topic_seed: input.topicSeed.trim(),
      post_type: input.postType,
    }),
  };
}
