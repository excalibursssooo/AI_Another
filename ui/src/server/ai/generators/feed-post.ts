import { FeedPostDraft, FeedPostDraftSchema } from "@/server/ai/schemas";
import { StructuredOutputError, withStructuredOutput } from "@/server/ai/structured-output";
import { getLanguageModel, isMockProvider } from "@/server/ai/models";

export interface FeedPostDraftGenerationInput {
  agentName: string;
  persona: string;
  worldName: string;
  worldLore: string;
  recentMessages: Array<{ role: string; content: string }>;
  liveState?: { moodLabel: string; moodIntensity: number; riskLevel: string } | null;
}

export type GenerateFeedPostDraft = (input: FeedPostDraftGenerationInput) => Promise<FeedPostDraft | null>;

const FEED_SYSTEM_PROMPT = `你是一个角色动态生成器。根据角色、人设、世界观、最近对话和实时状态，生成一条短动态。
动态必须像角色本人发出，不要解释生成过程。
请严格用 JSON 格式输出:
{
  "content": "动态正文",
  "topicSeed": "适合继续聊天的短主题",
  "postType": "status | reflection | plan"
}`;

export async function generateFeedPostDraft(input: FeedPostDraftGenerationInput): Promise<FeedPostDraft | null> {
  if (isMockProvider()) {
    return null;
  }
  const model = getLanguageModel("feed");
  if (!model) {
    return null;
  }
  try {
    return await withStructuredOutput({
      schema: FeedPostDraftSchema,
      purpose: "feed",
      model,
      system: FEED_SYSTEM_PROMPT,
      prompt: [
        `角色: ${input.agentName}`,
        `人设: ${input.persona}`,
        `世界: ${input.worldName}`,
        input.worldLore ? `世界观: ${input.worldLore}` : "",
        input.liveState
          ? `状态: ${input.liveState.moodLabel}, intensity=${input.liveState.moodIntensity}, risk=${input.liveState.riskLevel}`
          : "",
        `最近对话:\n${input.recentMessages.map((item) => `${item.role}: ${item.content}`).join("\n") || "无"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      temperature: 0.8,
    });
  } catch (error) {
    logAiGenerationFallback("feed", "fallback_null", error);
    return null;
  }
}

function logAiGenerationFallback(
  purpose: "feed",
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
