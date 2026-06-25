import { AppDatabase } from "@/server/db/client";
import {
  AgentRepository,
  ConversationRepository,
  FeedPostRecord,
  FeedPostRepository,
  WorldRepository,
} from "@/server/domain/chat/repositories";

import { Flow } from "./runner";
import { FlowNode } from "./types";

export interface FeedGenerateContext {
  userId: string;
  agentId: string;
  worldId: string;
  sourceTaskId?: string | null;
  topicSeed?: string;
  content?: string;
  postType?: FeedPostRecord["postType"];
  skipped?: boolean;
  reason?: string;
  post?: FeedPostRecord | null;
}

export interface PostTriggerResult {
  postId: string;
  userId: string;
  agentId: string;
  suggestedMessage: string;
}

export function createFeedGenerateFlow(options: { db: AppDatabase }): Flow<FeedGenerateContext> {
  const agents = new AgentRepository(options.db);
  const worlds = new WorldRepository(options.db);
  const conversations = new ConversationRepository(options.db);
  const posts = new FeedPostRepository(options.db);

  const nodes: FlowNode<FeedGenerateContext>[] = [
    {
      name: "LoadAgent",
      run: async (ctx) => {
        const agent = agents.get(ctx.agentId);
        if (!agent || agent.status !== "active") {
          return { ...ctx, skipped: true, reason: "agent not found", post: null };
        }
        return ctx;
      },
    },
    {
      name: "LoadWorld",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        if (!worlds.get(ctx.worldId)) {
          return { ...ctx, skipped: true, reason: "world not found", post: null };
        }
        return ctx;
      },
    },
    {
      name: "GenerateFeedPost",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        const agent = agents.get(ctx.agentId)!;
        const recent = conversations.recentMessagesForScope({
          userId: ctx.userId,
          agentId: ctx.agentId,
          worldId: ctx.worldId,
          limit: 4,
        });
        const lastUserMessage = [...recent].reverse().find((item) => item.role === "user")?.content;
        const topicSeed = extractTopic(lastUserMessage || agent.persona);
        return {
          ...ctx,
          topicSeed,
          postType: lastUserMessage ? "reflection" : "status",
          content: `${agent.displayName}：今天想把${topicSeed}这件事讲给你听。`,
        };
      },
    },
    {
      name: "PersistFeedPost",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        const agent = agents.get(ctx.agentId)!;
        return {
          ...ctx,
          skipped: false,
          reason: "generated",
          post: posts.create({
            userId: ctx.userId,
            agentId: ctx.agentId,
            agentName: agent.displayName || agent.name,
            worldId: ctx.worldId,
            content: ctx.content ?? "",
            topicSeed: ctx.topicSeed ?? "日常",
            postType: ctx.postType ?? "status",
            status: "published",
            sourceTaskId: ctx.sourceTaskId ?? null,
          }),
        };
      },
    },
  ];

  return new Flow(nodes);
}

export function createPostTrigger(input: { db: AppDatabase; postId: string; userId: string }): PostTriggerResult | null {
  const post = new FeedPostRepository(input.db).get(input.postId);
  if (!post || post.userId !== input.userId || post.status !== "published") {
    return null;
  }
  return {
    postId: post.id,
    userId: input.userId,
    agentId: post.agentId,
    suggestedMessage: `我想聊聊你刚才动态里提到的「${post.topicSeed}」。`,
  };
}

function extractTopic(text: string): string {
  const normalized = text.replace(/[。！？!?，,]/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words.slice(0, 4).join(" ");
  }
  return normalized.slice(0, 18) || "日常";
}
