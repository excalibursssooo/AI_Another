import { StructuredOutputError } from "@/server/ai/structured-output";
import type { ModelPurpose } from "@/server/ai/models";

export type AiGenerationFallbackOutcome = "fallback_reply" | "fallback_null";

export function logAiGenerationFallback(input: {
  purpose: ModelPurpose;
  outcome: AiGenerationFallbackOutcome;
  error: unknown;
}): void {
  const detail = {
    purpose: input.purpose,
    outcome: input.outcome,
    errorName: input.error instanceof Error ? input.error.name : typeof input.error,
    reason: input.error instanceof StructuredOutputError ? input.error.reason : "unexpected_error",
    schemaName: input.error instanceof StructuredOutputError ? input.error.schemaName : undefined,
  };
  console.warn("[ai-generation]", JSON.stringify(detail));
}
