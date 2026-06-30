import type { VisibleActorDirective } from "@/server/domain/world/types";

interface ChatPromptAgent {
  displayName?: string;
  name?: string;
  persona?: string;
  background?: string;
  speakingStyle?: string;
}

interface ChatPromptWorld {
  lore?: string;
}

interface ChatPromptMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

interface ChatPromptMemory {
  memoryType: string;
  content: string;
}

export interface ChatPromptContext {
  input: string;
  agent?: ChatPromptAgent;
  world?: ChatPromptWorld;
  recentMessages?: ChatPromptMessage[];
  recalledMemories?: ChatPromptMemory[];
  worldDirective?: Pick<VisibleActorDirective, "actorInstruction"> | null;
}

export function buildChatSystemPrompt(ctx: ChatPromptContext): string {
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

export function buildChatUserPrompt(ctx: ChatPromptContext): string {
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
