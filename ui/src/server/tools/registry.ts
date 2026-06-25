import { tool } from "ai";
import { z } from "zod";

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

export function createToolRegistry(scope: ToolScope) {
  const actions = createLowRiskToolActions(scope);
  return {
    searchMemories: tool({
      description: "Search active long-term memories scoped to the current user, agent, and world.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      execute: actions.searchMemories,
    }),
    createTaskDraft: tool({
      description: "Create a draft task payload only. This does not execute or persist the task.",
      inputSchema: z.object({
        title: z.string().min(1),
        priority: z.enum(["low", "medium", "high"]),
      }),
      execute: actions.createTaskDraft,
    }),
    createFeedPostDraft: tool({
      description: "Create a draft feed post payload only. This does not publish the post.",
      inputSchema: z.object({
        content: z.string().min(1),
        topicSeed: z.string().min(1),
        postType: z.enum(["status", "reflection", "plan"]).default("status"),
      }),
      execute: actions.createFeedPostDraft,
    }),
  };
}
