import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorldFlow: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/flow/world-flow", () => ({
  createWorldFlow: mocks.createWorldFlow,
}));

import { POST } from "./route";

afterEach(() => {
  mocks.createWorldFlow.mockReset();
});

function worldRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/worlds", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/worlds request validation", () => {
  it("returns 400 for invalid JSON before creating the flow", async () => {
    const response = await POST(
      new Request("http://localhost/api/worlds", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createWorldFlow).not.toHaveBeenCalled();
  });

  it("returns 400 for blank required fields before creating the flow", async () => {
    const response = await POST(
      worldRequest({
        name: "  ",
        constraints: "not-an-array",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.createWorldFlow).not.toHaveBeenCalled();
  });
});
