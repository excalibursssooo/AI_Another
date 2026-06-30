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
import { GenerateChatReply, generateChatReply as defaultGenerateChatReply } from "@/server/ai/chat";
import { createChatToolSet } from "@/server/tools/registry";

import { Flow } from "./runner";
import { FlowNode } from "./types";
import type { VisibleActorDirective } from "@/server/domain/world/types";

export interface ChatDoneEventPayload {
  type: "done";
  agent_id: string;
  agent_name: string;
  emotion_label: string;
  mood_intensity: number;
  heartbeat_bpm: number;
  risk_level: string;
  recalled_memories: Array<{ memory_type: string; content: string }>;
  persisted_memory_count: number;
}

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
      name: "LoadWorld",
      run: async (ctx) => {
        const world = worlds.get(ctx.worldId) ?? worlds.get("default");
        if (!world) {
          throw new Error("world not found");
        }
        return { ...ctx, world };
      },
    },
    {
      name: "SafetyCheck",
      run: async (ctx) => {
        const risk = assessRisk(ctx.input);
        if (risk === "high") {
          const reply = "我在这里。你现在的安全最重要，请先远离危险物品，并尽快联系身边可信任的人或当地紧急服务。";
          return finalize({
            ...ctx,
            blocked: true,
            riskLevel: "high",
            reply,
            mood: { label: "high_risk", intensity: 1, heartbeatBpm: 108 },
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
          systemPrompt: buildSystemPrompt(ctx),
          userPrompt: buildUserPrompt(ctx),
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
          tools:
            process.env.ENABLE_TOOLS === "true"
              ? createChatToolSet({
                  db: options.db,
                  userId: ctx.userId,
                  agentId: ctx.agentId,
                  worldId: ctx.worldId,
                })
              : undefined,
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
        return finalize({ ...ctx, persistedMemoryCount: 0 });
      },
    },
  ];

  return new Flow(nodes);
}

function finalize(ctx: ChatContext): ChatContext {
  const agentName = ctx.agent?.displayName || ctx.agent?.name || ctx.agentId;
  return {
    ...ctx,
    doneEvent: {
      type: "done",
      agent_id: ctx.agentId,
      agent_name: agentName,
      emotion_label: ctx.mood?.label ?? "neutral",
      mood_intensity: ctx.mood?.intensity ?? 0.35,
      heartbeat_bpm: ctx.mood?.heartbeatBpm ?? 72,
      risk_level: ctx.riskLevel ?? "low",
      recalled_memories: (ctx.recalledMemories ?? []).map((item) => ({
        memory_type: item.memoryType,
        content: item.content,
      })),
      persisted_memory_count: ctx.persistedMemoryCount ?? 0,
    },
  };
}

function assessRisk(input: string): "low" | "medium" | "high" {
  const normalized = input.toLowerCase();
  if (/(自杀|轻生|结束生命|kill myself|suicide)/i.test(normalized)) {
    return "high";
  }
  if (/(崩溃|绝望|伤害自己|self harm)/i.test(normalized)) {
    return "medium";
  }
  return "low";
}

function buildSystemPrompt(ctx: ChatContext): string {
  const agent = ctx.agent;
  const world = ctx.world;
  return [
    `你正在扮演 ${agent?.displayName ?? agent?.name ?? "AI 角色"}。`,
    agent?.persona ? `角色性格: ${agent.persona}` : "",
    agent?.background ? `角色背景: ${agent.background}` : "",
    agent?.speakingStyle ? `说话风格: ${agent.speakingStyle}` : "",
    world?.lore ? `世界观: ${world.lore}` : "",
    "请用自然、简洁、符合角色的中文回复。",
    ctx.worldDirective?.actorInstruction ? `当前世界指令: ${ctx.worldDirective.actorInstruction}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserPrompt(ctx: ChatContext): string {
  const history = (ctx.recentMessages ?? [])
    .map((item) => `${item.role === "user" ? "用户" : ctx.agent?.displayName ?? "角色"}: ${item.content}`)
    .join("\n");
  const memory = (ctx.recalledMemories ?? [])
    .map((item) => `- ${item.memoryType}: ${item.content}`)
    .join("\n");

  return [
    history ? `最近对话:\n${history}` : "最近对话: 无",
    memory ? `可用记忆:\n${memory}` : "可用记忆: 无",
    `用户当前输入: ${ctx.input}`,
  ].join("\n\n");
}
