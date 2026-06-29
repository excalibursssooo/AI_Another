import { getActiveProviderInfo } from "./models";
import { withStructuredOutput } from "./structured-output";
import { WorldMindDecisionSchema, type WorldMindDecision } from "@/server/domain/world/world-decision";

export interface GeneratedWorldDecision {
  decision: WorldMindDecision;
  rawDecisionJson: string;
  modelProvider: string;
  modelName: string;
}

export type GenerateWorldDecision = (input: { system: string; prompt: string }) => Promise<GeneratedWorldDecision>;

export const generateWorldDecision: GenerateWorldDecision = async ({ system, prompt }) => {
  const provider = getActiveProviderInfo();
  const decision = await withStructuredOutput({
    schema: WorldMindDecisionSchema,
    purpose: "worldDirector",
    system,
    prompt,
    temperature: 0.4,
  });

  return {
    decision,
    rawDecisionJson: JSON.stringify(decision),
    modelProvider: provider.provider,
    modelName: provider.model,
  };
};
