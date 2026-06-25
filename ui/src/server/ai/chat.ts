import { anthropic } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { generateObject, LanguageModel } from "ai";

import { ChatReply, ChatReplySchema } from "./schemas";

export interface ChatGenerationInput {
  system: string;
  prompt: string;
}

export type GenerateChatReply = (input: ChatGenerationInput) => Promise<ChatReply>;

export async function generateChatReply(input: ChatGenerationInput): Promise<ChatReply> {
  if ((process.env.AI_PROVIDER ?? "mock") === "mock") {
    return {
      reply: "我在这里。你刚才说的我记住了。",
      mood: { label: "calm", intensity: 0.35, heartbeatBpm: 72 },
    };
  }

  const model = getChatModel();
  if (!model) {
    return fallbackReply();
  }

  try {
    const result = await generateObject({
      model,
      schema: ChatReplySchema,
      system: input.system,
      prompt: input.prompt,
      temperature: 0.7,
    });
    return result.object;
  } catch {
    return fallbackReply();
  }
}

function getChatModel(): LanguageModel | null {
  const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  const modelName = process.env.CHAT_MODEL?.trim();

  if (provider === "minimax") {
    const apiKey = process.env.MINIMAX_API_KEY?.trim();
    const baseURL = process.env.MINIMAX_BASE_URL?.trim();
    if (!apiKey || !baseURL || !modelName) {
      return null;
    }
    return createOpenAI({ name: "minimax", apiKey, baseURL }).chat(modelName);
  }

  if (provider === "openai") {
    return openai.chat(modelName || "gpt-4o-mini");
  }

  if (provider === "anthropic") {
    return anthropic(modelName || "claude-3-5-haiku-latest");
  }

  if (provider === "google") {
    return google(modelName || "gemini-2.0-flash");
  }

  if (provider === "deepseek") {
    return deepseek(modelName || "deepseek-chat");
  }

  return null;
}

function fallbackReply(): ChatReply {
  return {
    reply: "当前模型暂时不可用，但我已经收到你的消息了。",
    mood: { label: "neutral", intensity: 0.25, heartbeatBpm: 72 },
  };
}
