import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import type { ZodType } from "zod";
import { z } from "zod";

import { getLanguageModel } from "./models";
import type { ModelPurpose } from "./models";

export type StructuredOutputFailureReason = "model_unavailable" | "generate_text_failed" | "missing_output";

export class StructuredOutputError extends Error {
  name = "StructuredOutputError";

  constructor(
    public readonly schemaName: string,
    public readonly reason: StructuredOutputFailureReason,
    public override readonly cause?: unknown,
  ) {
    super(`Structured output generation failed for schema: ${schemaName}`);
  }
}

export async function withStructuredOutput<TSchema extends ZodType>({
  schema,
  purpose,
  prompt,
  system,
  model: providedModel,
  tools,
  temperature = 0.7,
  abortSignal,
}: {
  schema: TSchema;
  purpose: ModelPurpose;
  prompt: string;
  system?: string;
  model?: LanguageModel;
  tools?: Parameters<typeof generateText>[0]["tools"];
  temperature?: number;
  abortSignal?: AbortSignal;
}): Promise<z.infer<TSchema>> {
  const model = providedModel ?? getLanguageModel(purpose);
  const schemaName = (schema as { name?: string }).name ?? "unknown";
  if (!model) {
    throw new StructuredOutputError(schemaName, "model_unavailable");
  }

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      output: Output.object({ schema }),
      system,
      prompt,
      tools,
      temperature,
      abortSignal,
    });
  } catch (error) {
    throw new StructuredOutputError(schemaName, "generate_text_failed", error);
  }

  if (result.output === undefined) {
    throw new StructuredOutputError(schemaName, "missing_output");
  }

  return result.output as z.infer<TSchema>;
}
