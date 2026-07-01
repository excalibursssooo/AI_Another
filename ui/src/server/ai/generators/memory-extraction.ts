import { MemoryExtraction, MemoryExtractionSchema } from "@/server/ai/schemas";
import { getLanguageModel, isMockProvider } from "@/server/ai/models";
import { StructuredOutputError, withStructuredOutput } from "@/server/ai/structured-output";

export interface MemoryExtractionGenerationInput {
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
}

export type GenerateMemoryExtraction = (input: MemoryExtractionGenerationInput) => Promise<MemoryExtraction | null>;

const MEMORY_SYSTEM_PROMPT = `你是一个长期记忆抽取器。只抽取对后续长期陪伴有帮助、稳定、明确的事实。
不要抽取寒暄、一次性情绪、模型自己的措辞或不确定推断。
请严格用 JSON 格式输出:
{
  "memories": [
    {
      "subject": "user | agent | world",
      "type": "profile | preference | relationship | event | goal | boundary | lore",
      "content": "可独立理解的一条中文记忆",
      "importance": 0.0,
      "confidence": 0.0
    }
  ]
}`;

export async function generateMemoryExtraction(
  input: MemoryExtractionGenerationInput,
): Promise<MemoryExtraction | null> {
  if (isMockProvider()) {
    return { memories: [] };
  }
  const model = getLanguageModel("memory");
  if (!model) {
    return null;
  }
  try {
    return await withStructuredOutput({
      schema: MemoryExtractionSchema,
      purpose: "memory",
      model,
      system: MEMORY_SYSTEM_PROMPT,
      prompt: [
        input.agentName ? `角色名: ${input.agentName}` : "",
        `用户: ${input.userMessage}`,
        `角色: ${input.assistantMessage}`,
      ]
        .filter(Boolean)
        .join("\n"),
      temperature: 0.2,
    });
  } catch (error) {
    logAiGenerationFallback("memory", "fallback_null", error);
    return null;
  }
}

function logAiGenerationFallback(
  purpose: "memory",
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
