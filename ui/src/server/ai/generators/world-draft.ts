import { WorldDraft, WorldDraftSchema } from "@/server/ai/schemas";
import { getLanguageModel, isMockProvider } from "@/server/ai/models";
import { StructuredOutputError, withStructuredOutput } from "@/server/ai/structured-output";

export interface WorldDraftGenerationInput {
  prompt: string;
  worldId?: string | null;
}

export type GenerateWorldDraft = (input: WorldDraftGenerationInput) => Promise<WorldDraft | null>;

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
  } catch (error) {
    logAiGenerationFallback("worldCreator", "fallback_null", error);
    return null;
  }
}

function logAiGenerationFallback(
  purpose: "worldCreator",
  outcome: "fallback_null",
  error: unknown,
): void {
  const detail = {
    purpose,
    outcome,
    errorName: error instanceof Error ? error.name : typeof error,
    reason: error instanceof StructuredOutputError ? error.reason : "unexpected_error",
    schemaName: error instanceof StructuredOutputError ? error.schemaName : undefined,
  };
  console.warn("[ai-generation]", JSON.stringify(detail));
}
