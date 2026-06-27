import { AppDatabase } from "@/server/db/client";
import {
  AgentLiveStateRecord,
  AgentLiveStateRepository,
  AgentRecord,
  AgentRepository,
  ConversationMessageRecord,
  ConversationRepository,
  FeedPostRecord,
  FeedPostRepository,
  WorldRecord,
  WorldRepository,
} from "@/server/domain/chat/repositories";
import {
  GenerateFeedPostDraft,
  generateFeedPostDraft as defaultGenerateFeedPostDraft,
} from "@/server/ai/chat";

import { Flow } from "./runner";
import { FlowNode } from "./types";

export interface FeedGenerateContext {
  userId: string;
  agentId: string;
  worldId: string;
  sourceTaskId?: string | null;
  agent?: AgentRecord;
  world?: WorldRecord;
  recentMessages?: ConversationMessageRecord[];
  liveState?: AgentLiveStateRecord;
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

export function createFeedGenerateFlow(options: {
  db: AppDatabase;
  generateFeedPostDraft?: GenerateFeedPostDraft;
}): Flow<FeedGenerateContext> {
  const agents = new AgentRepository(options.db);
  const worlds = new WorldRepository(options.db);
  const conversations = new ConversationRepository(options.db);
  const posts = new FeedPostRepository(options.db);
  const liveStates = new AgentLiveStateRepository(options.db);
  const generateDraft = options.generateFeedPostDraft ?? defaultGenerateFeedPostDraft;

  const nodes: FlowNode<FeedGenerateContext>[] = [
    {
      name: "LoadAgent",
      run: async (ctx) => {
        const agent = agents.get(ctx.agentId);
        if (!agent || agent.status !== "active") {
          return { ...ctx, skipped: true, reason: "agent not found", post: null };
        }
        return { ...ctx, agent };
      },
    },
    {
      name: "LoadWorld",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        const world = worlds.get(ctx.worldId);
        if (!world) {
          return { ...ctx, skipped: true, reason: "world not found", post: null };
        }
        return { ...ctx, world };
      },
    },
    {
      name: "LoadRecentMessages",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        return {
          ...ctx,
          recentMessages: conversations.recentMessagesForScope({
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
            limit: 4,
          }),
        };
      },
    },
    {
      name: "LoadLiveState",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        const agentName = ctx.agent?.displayName || ctx.agent?.name || ctx.agentId;
        return {
          ...ctx,
          liveState: liveStates.get(ctx.userId, ctx.agentId, agentName),
        };
      },
    },
    {
      name: "GenerateFeedPost",
      run: async (ctx) => {
        if (ctx.skipped) {
          return ctx;
        }
        const agent = ctx.agent!;
        const recent = ctx.recentMessages ?? [];
        const generated = await generateDraft({
          agentName: agent.displayName || agent.name,
          persona: agent.persona,
          worldName: ctx.world?.name ?? ctx.worldId,
          worldLore: ctx.world?.lore ?? "",
          recentMessages: recent.map((item) => ({ role: item.role, content: item.content })),
          liveState: ctx.liveState
            ? {
                moodLabel: ctx.liveState.moodLabel,
                moodIntensity: ctx.liveState.moodIntensity,
                riskLevel: ctx.liveState.riskLevel,
              }
            : null,
        });
        if (generated) {
          return {
            ...ctx,
            topicSeed: generated.topicSeed,
            postType: generated.postType,
            content: generated.content,
          };
        }
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
        const agent = ctx.agent ?? agents.get(ctx.agentId)!;
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
