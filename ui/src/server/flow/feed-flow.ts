import { AppDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import type { AgentRecord } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import type { WorldRecord } from "@/server/domain/world/world-repository";
import { ConversationRepository } from "@/server/domain/conversation/conversation-repository";
import type { ConversationMessageRecord } from "@/server/domain/conversation/conversation-repository";
import { AgentLiveStateRepository } from "@/server/domain/live-state/agent-live-state-repository";
import type { AgentLiveStateRecord } from "@/server/domain/live-state/agent-live-state-repository";
import { FeedPostRepository } from "@/server/domain/feed/feed-post-repository";
import type { FeedPostRecord } from "@/server/domain/feed/feed-post-repository";
import {
  GenerateFeedPostDraft,
  generateFeedPostDraft as defaultGenerateFeedPostDraft,
} from "@/server/ai/generators/feed-post";
import { embedText as defaultEmbedText } from "@/server/ai/embeddings";
import type { EmbedText } from "@/server/domain/chat/memory-consolidator";
import { FeedTopicRepository, normalizeAgentId, TOPIC_RECENT_WINDOW_DAYS } from "@/server/domain/chat/feed-topic-repository";
import { MemoryOperationLogRepository } from "@/server/domain/chat/memory-operation-log-repository";

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
  embedText?: EmbedText;
}): Flow<FeedGenerateContext> {
  const agents = new AgentRepository(options.db);
  const worlds = new WorldRepository(options.db);
  const conversations = new ConversationRepository(options.db);
  const posts = new FeedPostRepository(options.db);
  const liveStates = new AgentLiveStateRepository(options.db);
  const generateDraft = options.generateFeedPostDraft ?? defaultGenerateFeedPostDraft;
  const embedFn = options.embedText ?? defaultEmbedText;

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
        const topicSeed = await extractTopicWithCluster({
          db: options.db,
          content: lastUserMessage || agent.persona,
          userId: ctx.userId,
          agentId: ctx.agentId,
          worldId: ctx.worldId,
          sourceTaskId: ctx.sourceTaskId,
          embedText: embedFn,
        });
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

const TOPIC_KEY_MAX_CJK = 8;
const TOPIC_KEY_MAX_WORDS = 4;
const TOPIC_MATCH_SIMILARITY = 0.75;

export async function extractTopicWithCluster(input: {
  db: AppDatabase;
  content: string;
  userId: string;
  agentId: string | null;
  worldId: string;
  sourceTaskId?: string | null;
  embedText?: EmbedText;
}): Promise<string> {
  const topics = new FeedTopicRepository(input.db);
  const logs = new MemoryOperationLogRepository(input.db);
  const effectiveAgentId = normalizeAgentId(input.agentId);
  const embedFn = input.embedText ?? defaultEmbedText;
  const embedding = await embedFn(input.content);

  if (embedding.fallbackReason !== undefined || embedding.quality !== "semantic") {
    logs.record({
      kind: "topic_fallback", reason: "embedding_unavailable",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
    });
    return extractTopicFallback(input.content);
  }

  const recent = topics.listRecent({
    userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
    sinceDays: TOPIC_RECENT_WINDOW_DAYS,
  });

  if (recent.length === 0) {
    const key = topics.create({
      userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
      topicKey: extractTopicFallback(input.content),
      embedding,
    });
    logs.record({
      kind: "topic_fallback", reason: "cold_start",
      sourceTaskId: input.sourceTaskId ?? null,
      userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
    });
    return key;
  }

  const matched = topics.bestMatchByCosine(recent, embedding, TOPIC_MATCH_SIMILARITY);
  if (matched) {
    topics.touch(matched.id);
    return matched.topicKey;
  }

  const key = topics.create({
    userId: input.userId, worldId: input.worldId, agentId: effectiveAgentId,
    topicKey: extractTopicFallback(input.content),
    embedding,
  });
  logs.record({
    kind: "topic_fallback", reason: "no_match",
    sourceTaskId: input.sourceTaskId ?? null,
    userId: input.userId, agentId: effectiveAgentId, worldId: input.worldId,
  });
  return key;
}

function extractTopicFallback(text: string): string {
  const normalized = text.replace(/[。！？!?，,]/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const candidate = words.length > 0 ? words.slice(0, 4).join(" ") : normalized.slice(0, 18);
  return clampTopicKey(candidate) || "日常";
}

function clampTopicKey(s: string): string {
  const cjkChars = [...s].filter((ch) => /[一-龥]/.test(ch));
  if (cjkChars.length > TOPIC_KEY_MAX_CJK) {
    return cjkChars.slice(0, TOPIC_KEY_MAX_CJK).join("");
  }
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > TOPIC_KEY_MAX_WORDS) return words.slice(0, TOPIC_KEY_MAX_WORDS).join(" ");
  return s;
}
