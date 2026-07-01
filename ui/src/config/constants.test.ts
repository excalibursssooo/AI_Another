import { describe, expect, it } from "vitest";

import { DEMO_USER_ID, resolveDemoUserId } from "./constants";

describe("demo user configuration", () => {
  it("uses the trimmed environment user id when provided", () => {
    expect(resolveDemoUserId("  user-custom  ")).toBe("user-custom");
  });

  it("falls back to the explicit demo user id when the environment value is blank", () => {
    expect(resolveDemoUserId("  ")).toBe(DEMO_USER_ID);
    expect(resolveDemoUserId(undefined)).toBe(DEMO_USER_ID);
  });
});
