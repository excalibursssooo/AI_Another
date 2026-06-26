import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import type { ZodType } from "zod";
import { z } from "zod";

import { getLanguageModel } from "./models";
import type { ModelPurpose } from "./models";

export class StructuredOutputError extends Error {
  name = "StructuredOutputError";

  constructor(public readonly schemaName: string) {
    super(`Structured output generation failed for schema: ${schemaName}`);
  }
}

export async function withStructuredOutput<TSchema extends ZodType>({
  schema,
  purpose,
  prompt,
  system,
  model: providedModel,
  temperature = 0.7,
  abortSignal,
}: {
  schema: TSchema;
  purpose: ModelPurpose;
  prompt: string;
  system?: string;
  model?: LanguageModel;
  temperature?: number;
  abortSignal?: AbortSignal;
}): Promise<z.infer<TSchema>> {
  const model = providedModel ?? getLanguageModel(purpose);
  const schemaName = (schema as { name?: string }).name ?? "unknown";
  if (!model) {
    throw new StructuredOutputError(schemaName);
  }

  const result = await generateText({
    model,
    output: Output.object({ schema }),
    system,
    prompt,
    temperature,
    abortSignal,
  });

  if (result.output === undefined) {
    throw new StructuredOutputError(schemaName);
  }

  return result.output as z.infer<TSchema>;
}
