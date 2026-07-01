import { AppDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import type { AgentRecord } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import type { WorldRecord } from "@/server/domain/world/world-repository";
import { ConversationRepository } from "@/server/domain/conversation/conversation-repository";
import type { ConversationMessageRecord } from "@/server/domain/conversation/conversation-repository";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";
import type { MemoryRecord } from "@/server/domain/memory/memory-repository";
import { AgentLiveStateRepository } from "@/server/domain/live-state/agent-live-state-repository";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { finalizeChatContext } from "@/server/domain/chat/chat-finalizer";
import type { ChatDoneEventPayload } from "@/server/domain/chat/chat-finalizer";
import { buildChatSystemPrompt, buildChatUserPrompt } from "@/server/domain/chat/chat-prompt-builder";
import { assessChatRisk, HIGH_RISK_MOOD, HIGH_RISK_REPLY } from "@/server/domain/chat/chat-safety";
import { GenerateChatReply, generateChatReply as defaultGenerateChatReply } from "@/server/ai/chat";
import { createChatToolsForScope } from "@/server/tools/tool-policy";

import { Flow } from "./runner";
import { FlowNode } from "./types";
import type { VisibleActorDirective } from "@/server/domain/world/types";

export interface ChatContext {
  userId: string;
  agentId: string;
  worldId: string;
  input: string;
  agent?: AgentRecord;
  world?: WorldRecord;
  conversationId?: string;
  recentMessages?: ConversationMessageRecord[];
  recalledMemories?: MemoryRecord[];
  sourceMessageId?: string;
  systemPrompt?: string;
  userPrompt?: string;
  reply?: string;
  mood?: { label: string; intensity: number; heartbeatBpm: number };
  blocked?: boolean;
  riskLevel?: "low" | "medium" | "high";
  persistedMemoryCount?: number;
  doneEvent?: ChatDoneEventPayload;
  worldDirective?: VisibleActorDirective | null;
}

function loadWorldWithFallback(worlds: WorldRepository, worldId: string): WorldRecord | null {
  return worlds.get(worldId) ?? worlds.get("default");
}

export function createChatFlow(options: { db: AppDatabase; generateChatReply?: GenerateChatReply }): Flow<ChatContext> {
  const agents = new AgentRepository(options.db);
  const worlds = new WorldRepository(options.db);
  const conversations = new ConversationRepository(options.db);
  const memories = new MemoryRepository(options.db);
  const liveStates = new AgentLiveStateRepository(options.db);
  const tasks = new TaskRepository(options.db);
  const generateReply = options.generateChatReply ?? defaultGenerateChatReply;

  const nodes: FlowNode<ChatContext>[] = [
    {
      name: "LoadAgent",
      run: async (ctx) => {
        const agent = agents.get(ctx.agentId);
        if (!agent || agent.status !== "active") {
          throw new Error("agent not found");
        }
        return { ...ctx, agent };
      },
    },
    {
      name: "LoadWorldWithFallback",
      run: async (ctx) => {
        const world = loadWorldWithFallback(worlds, ctx.worldId);
        if (!world) {
          throw new Error("world not found");
        }
        return { ...ctx, world };
      },
    },
    {
      name: "SafetyCheck",
      run: async (ctx) => {
        const risk = assessChatRisk(ctx.input);
        if (risk === "high") {
          return finalizeChatContext({
            ...ctx,
            blocked: true,
            riskLevel: "high",
            reply: HIGH_RISK_REPLY,
            mood: HIGH_RISK_MOOD,
            recalledMemories: [],
            persistedMemoryCount: 0,
          });
        }
        return { ...ctx, riskLevel: risk };
      },
    },
    {
      name: "LoadRecentMessages",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        const conversationId = conversations.ensureConversation({
          userId: ctx.userId,
          agentId: ctx.agentId,
          worldId: ctx.worldId,
        });
        return {
          ...ctx,
          conversationId,
          recentMessages: conversations.recentMessages(conversationId, 8),
        };
      },
    },
    {
      name: "RecallMemories",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        return {
          ...ctx,
          recalledMemories: memories.recall({
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
            query: ctx.input,
            limit: 5,
          }),
        };
      },
    },
    {
      name: "BuildPrompt",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        return {
          ...ctx,
          systemPrompt: buildChatSystemPrompt(ctx),
          userPrompt: buildChatUserPrompt(ctx),
        };
      },
    },
    {
      name: "GenerateReply",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        const generated = await generateReply({
          system: ctx.systemPrompt ?? "",
          prompt: ctx.userPrompt ?? ctx.input,
          tools: createChatToolsForScope({
            db: options.db,
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
          }),
        });
        return {
          ...ctx,
          reply: generated.reply,
          mood: generated.mood,
        };
      },
    },
    {
      name: "PersistConversation",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        const conversationId =
          ctx.conversationId ??
          conversations.ensureConversation({ userId: ctx.userId, agentId: ctx.agentId, worldId: ctx.worldId });
        const userMessage = conversations.appendMessage({ conversationId, role: "user", content: ctx.input });
        conversations.appendMessage({ conversationId, role: "assistant", content: ctx.reply ?? "" });
        return {
          ...ctx,
          conversationId,
          sourceMessageId: userMessage.id,
          recentMessages: conversations.recentMessages(conversationId, 8),
        };
      },
    },
    {
      name: "UpdateLiveState",
      run: async (ctx) => {
        if (ctx.blocked) {
          return ctx;
        }
        liveStates.upsert({
          agentId: ctx.agentId,
          userId: ctx.userId,
          agentName: ctx.agent?.displayName || ctx.agent?.name || ctx.agentId,
          moodLabel: ctx.mood?.label ?? "neutral",
          moodIntensity: ctx.mood?.intensity ?? 0.35,
          heartbeatBpm: ctx.mood?.heartbeatBpm ?? 72,
          riskLevel: ctx.riskLevel ?? "low",
          updatedAt: Date.now(),
        });
        return ctx;
      },
    },
    {
      name: "EnqueueMemoryExtraction",
      run: async (ctx) => {
        if (ctx.blocked) {
          liveStates.upsert({
            agentId: ctx.agentId,
            userId: ctx.userId,
            agentName: ctx.agent?.displayName || ctx.agent?.name || ctx.agentId,
            moodLabel: ctx.mood?.label ?? "high_risk",
            moodIntensity: ctx.mood?.intensity ?? 1,
            heartbeatBpm: ctx.mood?.heartbeatBpm ?? 108,
            riskLevel: ctx.riskLevel ?? "high",
            updatedAt: Date.now(),
          });
          return ctx;
        }
        tasks.enqueue({
          kind: "memory_extract",
          payload: {
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
            conversationId: ctx.conversationId ?? null,
            sourceMessageId: ctx.sourceMessageId ?? null,
            userMessage: ctx.input,
            assistantMessage: ctx.reply ?? "",
            fallbackReplies: [
              "我在这里。你刚才说的我记住了。",
              "当前模型暂时不可用，但我已经收到你的消息了。",
            ],
          },
        });
        return finalizeChatContext({ ...ctx, persistedMemoryCount: 0 });
      },
    },
  ];

  return new Flow(nodes);
}
