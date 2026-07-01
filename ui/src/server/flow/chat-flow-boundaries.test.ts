import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("ChatFlow boundaries", () => {
  it("does not read process.env directly", () => {
    const source = readFileSync(join(process.cwd(), "src/server/flow/chat-flow.ts"), "utf8");

    expect(source).not.toContain("process.env");
  });
});
