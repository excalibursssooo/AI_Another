import { anthropic } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type ModelPurpose = "chat" | "memory" | "agentCreator" | "worldCreator" | "feed";

export interface ActiveProviderInfo {
  provider: string;
  model: string;
}

export function isMockProvider(): boolean {
  return (process.env.AI_PROVIDER ?? "mock").toLowerCase() === "mock";
}

export function getActiveProviderInfo(): ActiveProviderInfo {
  const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  const model = process.env.CHAT_MODEL?.trim() || "mock";
  return { provider, model };
}

export function getLanguageModel(purpose: ModelPurpose = "chat"): LanguageModel | null {
  const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  const purposeEnvKeyByPurpose: Record<ModelPurpose, string> = {
    chat: "CHAT_MODEL",
    memory: "MEMORY_MODEL",
    agentCreator: "AGENT_CREATOR_MODEL",
    worldCreator: "WORLD_CREATOR_MODEL",
    feed: "FEED_MODEL",
  };
  const purposeEnvKey = purposeEnvKeyByPurpose[purpose];
  const modelName = process.env[purposeEnvKey]?.trim() || process.env.CHAT_MODEL?.trim();

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
