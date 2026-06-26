export { createLowRiskToolActions } from "./low-risk-actions";
export type { ToolScope } from "./low-risk-actions";

import { tool } from "ai";
import { z } from "zod";

import { createLowRiskToolActions } from "./low-risk-actions";
import type { ToolScope } from "./low-risk-actions";

export function createChatToolSet(scope: ToolScope) {
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
