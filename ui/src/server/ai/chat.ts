import { Output, streamText } from "ai";
import type { LanguageModel } from "ai";

import {
  ChatReply,
  ChatReplySchema,
  MemoryExtraction,
  MemoryExtractionSchema,
} from "./schemas";
import { withStructuredOutput, StructuredOutputError } from "./structured-output";
import type { createChatToolSet } from "@/server/tools/registry";

// Re-export provider-selection helpers from models.ts for backwards compatibility
export { isMockProvider, getActiveProviderInfo, getLanguageModel } from "./models";
export type { ModelPurpose, ActiveProviderInfo } from "./models";
export { generateFeedPostDraft } from "./generators/feed-post";
export type { FeedPostDraftGenerationInput, GenerateFeedPostDraft } from "./generators/feed-post";
export { generateWorldDraft } from "./generators/world-draft";
export type { WorldDraftGenerationInput, GenerateWorldDraft } from "./generators/world-draft";
export { generateAgentDraft } from "./generators/agent-draft";
export type { AgentDraftGenerationInput, GenerateAgentDraft } from "./generators/agent-draft";

// Import helpers for internal use within this module
import { isMockProvider, getLanguageModel } from "./models";

export interface ChatGenerationInput {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  tools?: ReturnType<typeof createChatToolSet>;
}

export type GenerateChatReply = (input: ChatGenerationInput) => Promise<ChatReply>;

export interface MemoryExtractionGenerationInput {
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
}

export type GenerateMemoryExtraction = (input: MemoryExtractionGenerationInput) => Promise<MemoryExtraction | null>;

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
      tools: input.tools,
      temperature: 0.7,
    });
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      logAiGenerationFallback("chat", "fallback_reply", error);
      return fallbackReply();
    }
    throw error;
  }
}

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

export async function generateMemoryExtraction(input: MemoryExtractionGenerationInput): Promise<MemoryExtraction | null> {
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

function fallbackReply(): ChatReply {
  return {
    reply: "当前模型暂时不可用，但我已经收到你的消息了。",
    mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
  };
}

function logAiGenerationFallback(
  purpose: "chat" | "memory" | "agentCreator" | "worldCreator" | "feed",
  outcome: "fallback_reply" | "fallback_null",
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

export interface StreamChatReplyResult {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<unknown>;
  object: Promise<ChatReply>;
  model: LanguageModel;
}

export async function streamChatReply(input: ChatGenerationInput): Promise<StreamChatReplyResult> {
  if (isMockProvider()) {
    return makeMockStreamReply();
  }

  const model = getLanguageModel("chat");
  if (!model) {
    return makeFallbackStreamReply();
  }

  const result = streamText({
    model,
    output: Output.object({ schema: ChatReplySchema }),
    system: input.system,
    prompt: input.prompt,
    temperature: 0.7,
    abortSignal: input.abortSignal,
  });

  return {
    textStream: result.textStream,
    fullStream: result.fullStream as AsyncIterable<unknown>,
    object: result.output as Promise<ChatReply>,
    model,
  };
}

function makeMockStreamReply(): StreamChatReplyResult {
  const reply: ChatReply = {
    reply: "我在这里。你刚才说的我记住了。",
    mood: { label: "calm", intensity: 0.35, heartbeatBpm: 72 },
  };
  async function* oneShot() {
    yield reply.reply;
  }
  async function* empty() {}
  return {
    textStream: oneShot(),
    fullStream: empty(),
    object: Promise.resolve(reply),
    model: {} as LanguageModel,
  };
}

function makeFallbackStreamReply(): StreamChatReplyResult {
  const reply: ChatReply = {
    reply: "当前模型暂时不可用，但我已经收到你的消息了。",
    mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
  };
  async function* oneShot() {
    yield reply.reply;
  }
  async function* empty() {}
  return {
    textStream: oneShot(),
    fullStream: empty(),
    object: Promise.resolve(reply),
    model: {} as LanguageModel,
  };
}
