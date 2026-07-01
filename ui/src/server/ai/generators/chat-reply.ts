import { Output, streamText } from "ai";
import type { LanguageModel } from "ai";

import { ChatReply, ChatReplySchema } from "@/server/ai/schemas";
import { getLanguageModel, isMockProvider } from "@/server/ai/models";
import { StructuredOutputError, withStructuredOutput } from "@/server/ai/structured-output";
import type { createChatToolSet } from "@/server/tools/registry";

export interface ChatGenerationInput {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  tools?: ReturnType<typeof createChatToolSet>;
}

export type GenerateChatReply = (input: ChatGenerationInput) => Promise<ChatReply>;

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

function fallbackReply(): ChatReply {
  return {
    reply: "当前模型暂时不可用，但我已经收到你的消息了。",
    mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
  };
}

function logAiGenerationFallback(
  purpose: "chat",
  outcome: "fallback_reply",
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
