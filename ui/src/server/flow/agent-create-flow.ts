import { AppDatabase } from "@/server/db/client";
import { AgentRecord, AgentRepository, MemoryRepository, WorldRepository } from "@/server/domain/chat/repositories";

import { Flow } from "./runner";
import { FlowNode } from "./types";

interface ManualAgentInput {
  name: string;
  persona: string;
  background: string;
  hobbies: readonly string[];
  speakingStyle: string;
}

interface AgentDraft {
  name: string;
  displayName: string;
  persona: string;
  background: string;
  greeting: string;
  speakingStyle: string;
  hobbies: string[];
}

export interface AgentCreateContext {
  mode: "manual" | "ai";
  userId: string;
  worldId: string;
  input?: ManualAgentInput;
  prompt?: string | null;
  draft?: AgentDraft;
  agent?: AgentRecord;
  backend?: string;
  model?: string;
  rawText?: string;
  persistedMemoryCount?: number;
}

export function createAgentCreateFlow(options: { db: AppDatabase }): Flow<AgentCreateContext> {
  const worlds = new WorldRepository(options.db);
  const agents = new AgentRepository(options.db);
  const memories = new MemoryRepository(options.db);

  const nodes: FlowNode<AgentCreateContext>[] = [
    {
      name: "LoadWorld",
      run: async (ctx) => {
        if (!worlds.get(ctx.worldId)) {
          throw new Error("world not found");
        }
        return ctx;
      },
    },
    {
      name: "GenerateAgentProfile",
      run: async (ctx) => {
        const draft = ctx.mode === "manual" ? draftFromManual(ctx.input) : draftFromPrompt(ctx.prompt);
        return {
          ...ctx,
          draft,
          backend: ctx.mode === "ai" ? "mock" : "manual",
          model: ctx.mode === "ai" ? "local-agent-generator" : "manual-input",
          rawText: ctx.mode === "ai" ? ctx.prompt?.trim() || "本地生成的长期陪伴角色" : JSON.stringify(ctx.input),
        };
      },
    },
    {
      name: "ValidateAgentProfile",
      run: async (ctx) => {
        if (!ctx.draft?.name.trim() || !ctx.draft.persona.trim()) {
          throw new Error("agent name and persona are required");
        }
        return ctx;
      },
    },
    {
      name: "PersistAgent",
      run: async (ctx) => ({
        ...ctx,
        agent: agents.create({
          ...ctx.draft!,
          worldId: ctx.worldId,
        }),
      }),
    },
    {
      name: "SeedAgentMemories",
      run: async (ctx) => {
        if (!ctx.agent) {
          return ctx;
        }
        const seeds = [
          { type: "profile", content: `${ctx.agent.displayName}: ${ctx.agent.persona}` },
          { type: "profile", content: ctx.agent.background },
        ].filter((item) => item.content.trim());
        for (const seed of seeds) {
          memories.create({
            userId: ctx.userId,
            agentId: ctx.agent.id,
            worldId: ctx.worldId,
            subject: "agent",
            memoryType: seed.type,
            content: seed.content,
            importance: 0.62,
            confidence: 0.8,
          });
        }
        return { ...ctx, persistedMemoryCount: seeds.length };
      },
    },
  ];

  return new Flow(nodes);
}

function draftFromManual(input?: ManualAgentInput): AgentDraft {
  if (!input) {
    throw new Error("manual agent input is required");
  }
  const name = input.name.trim();
  return {
    name,
    displayName: name,
    persona: input.persona.trim(),
    background: input.background.trim(),
    greeting: `你好，我是${name}。`,
    speakingStyle: input.speakingStyle.trim() || "自然、真诚",
    hobbies: [...input.hobbies].filter((item) => item.trim()).slice(0, 8),
  };
}

function draftFromPrompt(prompt?: string | null): AgentDraft {
  const text = prompt?.trim() || "一个温暖、稳定、会认真倾听的新朋友";
  const starName = /星|夜空|天文/.test(text) ? "星岚" : "新朋友";
  return {
    name: starName,
    displayName: starName,
    persona: `由提示生成，关注${shortTopic(text)}，温和且有边界。`,
    background: `来自你的描述: ${text}`,
    greeting: `你好，我是${starName}。我想慢慢了解你的日常。`,
    speakingStyle: "自然、简洁、带一点好奇心",
    hobbies: ["记录日常", "散步", "整理记忆"],
  };
}

function shortTopic(text: string): string {
  return text.replace(/[，。,.]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join("和") || "长期陪伴";
}
