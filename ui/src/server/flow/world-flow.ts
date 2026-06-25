import { AppDatabase } from "@/server/db/client";
import { WorldRecord, WorldRepository } from "@/server/domain/chat/repositories";

import { Flow } from "./runner";
import { FlowNode } from "./types";

interface ManualWorldInput {
  id?: string;
  name: string;
  lore: string;
  tone: string;
  constraints: readonly string[];
  seedMemories: readonly string[];
}

export interface WorldFlowContext {
  mode: "manual" | "ai";
  input?: ManualWorldInput;
  prompt?: string | null;
  worldId?: string | null;
  world?: WorldRecord;
  backend?: string;
  model?: string;
  rawText?: string;
}

export function createWorldFlow(options: { db: AppDatabase }): Flow<WorldFlowContext> {
  const worlds = new WorldRepository(options.db);

  const nodes: FlowNode<WorldFlowContext>[] = [
    {
      name: "GenerateWorld",
      run: async (ctx) => ({
        ...ctx,
        world: ctx.mode === "manual" ? worldFromManual(ctx.input) : worldFromPrompt(ctx.prompt, ctx.worldId),
        backend: ctx.mode === "ai" ? "mock" : "manual",
        model: ctx.mode === "ai" ? "local-world-generator" : "manual-input",
        rawText: ctx.mode === "ai" ? ctx.prompt?.trim() || "本地生成的陪伴世界" : JSON.stringify(ctx.input),
      }),
    },
    {
      name: "ValidateWorld",
      run: async (ctx) => {
        if (!ctx.world?.id.trim() || !ctx.world.name.trim()) {
          throw new Error("world id and name are required");
        }
        return ctx;
      },
    },
    {
      name: "PersistWorld",
      run: async (ctx) => ({
        ...ctx,
        world: worlds.upsert(ctx.world!),
      }),
    },
  ];

  return new Flow(nodes);
}

function worldFromManual(input?: ManualWorldInput): WorldRecord {
  if (!input) {
    throw new Error("manual world input is required");
  }
  const name = input.name.trim();
  return {
    id: normalizeWorldId(input.id || name),
    name,
    lore: input.lore.trim(),
    tone: input.tone.trim(),
    constraints: [...input.constraints].filter((item) => item.trim()).slice(0, 12),
    seedMemories: [...input.seedMemories].filter((item) => item.trim()).slice(0, 12),
  };
}

function worldFromPrompt(prompt?: string | null, worldId?: string | null): WorldRecord {
  const text = prompt?.trim() || "一个温和、适合长期陪伴的日常世界";
  const hasSea = /海|海风|港/.test(text);
  const name = hasSea ? "海风小镇" : "陪伴世界";
  return {
    id: normalizeWorldId(worldId || name),
    name,
    lore: `根据提示生成的世界: ${text}`,
    tone: hasSea ? "潮湿、安静、怀旧" : "温和、自然、真诚",
    constraints: ["保持世界观一致", "优先回应用户当下表达"],
    seedMemories: [text],
  };
}

function normalizeWorldId(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `world-${Date.now()}`;
}
