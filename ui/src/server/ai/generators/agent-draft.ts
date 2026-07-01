import { AgentDraft, AgentDraftSchema } from "@/server/ai/schemas";
import { getLanguageModel, isMockProvider } from "@/server/ai/models";
import { withStructuredOutput } from "@/server/ai/structured-output";
import { logAiGenerationFallback } from "@/server/ai/generation-logging";

export interface AgentDraftGenerationInput {
  prompt: string;
  world?: { id: string; name: string; lore: string; tone: string } | null;
}

export type GenerateAgentDraft = (input: AgentDraftGenerationInput) => Promise<AgentDraft | null>;

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
  } catch (error) {
    logAiGenerationFallback({ purpose: "agentCreator", outcome: "fallback_null", error });
    return null;
  }
}
