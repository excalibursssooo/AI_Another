import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseOptionalJsonBody } from "./request";

const OptionalPromptSchema = z.object({
  prompt: z.string().trim().optional(),
});

describe("parseOptionalJsonBody", () => {
  it("treats an empty body as an empty object", async () => {
    const result = await parseOptionalJsonBody(
      new Request("http://localhost/api/test", { method: "POST" }),
      OptionalPromptSchema,
    );

    expect(result).toEqual({});
  });

  it("rejects malformed JSON", async () => {
    await expect(
      parseOptionalJsonBody(
        new Request("http://localhost/api/test", {
          method: "POST",
          body: "{",
          headers: { "Content-Type": "application/json" },
        }),
        OptionalPromptSchema,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });
});
