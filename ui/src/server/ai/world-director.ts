import { withStructuredOutput } from "./structured-output";
import { WorldMindDecisionSchema, type WorldMindDecision } from "@/server/domain/world/world-decision";

export type GenerateWorldDecision = (input: { system: string; prompt: string }) => Promise<WorldMindDecision>;

export const generateWorldDecision: GenerateWorldDecision = async ({ system, prompt }) => {
  return withStructuredOutput({
    schema: WorldMindDecisionSchema,
    purpose: "worldDirector",
    system,
    prompt,
    temperature: 0.4,
  });
};
