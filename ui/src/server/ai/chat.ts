import {
  AgentDraft,
  AgentDraftSchema,
  ChatReply,
  ChatReplySchema,
  WorldDraft,
  WorldDraftSchema,
} from "./schemas";
import { withStructuredOutput, StructuredOutputError } from "./structured-output";

// Re-export provider-selection helpers from models.ts for backwards compatibility
export { isMockProvider, getActiveProviderInfo, getLanguageModel } from "./models";
export type { ModelPurpose, ActiveProviderInfo } from "./models";

// Import helpers for internal use within this module
import { isMockProvider, getLanguageModel } from "./models";

export interface ChatGenerationInput {
  system: string;
  prompt: string;
}

export type GenerateChatReply = (input: ChatGenerationInput) => Promise<ChatReply>;

export interface AgentDraftGenerationInput {
  prompt: string;
  world?: { id: string; name: string; lore: string; tone: string } | null;
}

export type GenerateAgentDraft = (input: AgentDraftGenerationInput) => Promise<AgentDraft | null>;

export interface WorldDraftGenerationInput {
  prompt: string;
  worldId?: string | null;
}

export type GenerateWorldDraft = (input: WorldDraftGenerationInput) => Promise<WorldDraft | null>;

export async function generateChatReply(input: ChatGenerationInput): Promise<ChatReply> {
  if (isMockProvider()) {
    return {
      reply: "我在这里。你刚才说的我记住了。",
      mood: { label: "calm", intensity: 0.35, heartbeatBpm: 72 },
    };
  }

  const model = getLanguageModel("chat");
  if (!model) {
    return fallbackReply();
  }

  try {
    return await withStructuredOutput({
      schema: ChatReplySchema,
      purpose: "chat",
      system: input.system,
      prompt: input.prompt,
      temperature: 0.7,
    });
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      return fallbackReply();
    }
    throw error;
  }
}

const AGENT_SYSTEM_PROMPT = `你是一个角色设定助手。根据用户的描述和所在的世界观，生成一个角色档案。
角色必须自然地归属于这个世界观（背景、说话风格、爱好都要呼应世界氛围），同时体现用户描述中的核心特征。
请严格用 JSON 格式输出（不要 markdown 代码块，不要额外解释）：
{
  "name": "角色名（2-6字，简洁好记）",
  "displayName": "显示名（通常与 name 相同）",
  "persona": "性格特点（1-2句中文）",
  "background": "角色背景故事（2-4句中文）",
  "greeting": "见面时的问候语（中文，1-2句）",
  "speakingStyle": "说话风格（中文，1-2句）",
  "hobbies": ["爱好1", "爱好2", "爱好3"]
}`;

export async function generateAgentDraft(input: AgentDraftGenerationInput): Promise<AgentDraft | null> {
  if (isMockProvider()) {
    return null;
  }
  const model = getLanguageModel("agentCreator");
  if (!model) {
    return null;
  }
  try {
    const worldBlock = input.world
      ? `\n\n所在世界:\n- 名称: ${input.world.name}\n- 氛围: ${input.world.tone}\n- 世界观: ${input.world.lore}`
      : "";
    return await withStructuredOutput({
      schema: AgentDraftSchema,
      purpose: "agentCreator",
      model,
      prompt: `用户想要的角色描述: ${input.prompt.trim()}${worldBlock}`,
      system: AGENT_SYSTEM_PROMPT,
      temperature: 0.8,
    });
  } catch {
    return null;
  }
}

const WORLD_SYSTEM_PROMPT = `你是一个世界观设定助手。根据用户的描述，生成一个虚构世界设定。
请严格用 JSON 格式输出（不要 markdown 代码块，不要额外解释）：
{
  "id": "英文 id（kebab-case，例如 coastal-bookshop）",
  "name": "世界名（2-8字）",
  "lore": "世界观描述（2-4句中文）",
  "tone": "氛围（2-4个中文关键词，逗号分隔）",
  "constraints": ["规则1", "规则2"],
  "seedMemories": ["记忆种子1", "记忆种子2"]
}`;

export async function generateWorldDraft(input: WorldDraftGenerationInput): Promise<WorldDraft | null> {
  if (isMockProvider()) {
    return null;
  }
  const model = getLanguageModel("worldCreator");
  if (!model) {
    return null;
  }
  try {
    const idHint = input.worldId?.trim() ? `\n\n用户偏好的世界 id（如果不合理可调整）: ${input.worldId.trim()}` : "";
    return await withStructuredOutput({
      schema: WorldDraftSchema,
      purpose: "worldCreator",
      model,
      prompt: `用户想要的世界描述: ${input.prompt.trim()}${idHint}`,
      system: WORLD_SYSTEM_PROMPT,
      temperature: 0.8,
    });
  } catch {
    return null;
  }
}

function fallbackReply(): ChatReply {
  return {
    reply: "当前模型暂时不可用，但我已经收到你的消息了。",
    mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
  };
}
