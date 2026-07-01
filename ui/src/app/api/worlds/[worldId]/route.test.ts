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

import { PUT } from "./route";

afterEach(() => {
  mocks.createWorldFlow.mockReset();
});

function worldRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/worlds/default", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function context(worldId = "default") {
  return { params: Promise.resolve({ worldId }) };
}

describe("/api/worlds/[worldId] request validation", () => {
  it("returns 400 for invalid JSON before creating the flow", async () => {
    const response = await PUT(
      new Request("http://localhost/api/worlds/default", {
        method: "PUT",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createWorldFlow).not.toHaveBeenCalled();
  });

  it("returns 400 for blank required fields before creating the flow", async () => {
    const response = await PUT(
      worldRequest({
        name: "  ",
        seed_memories: "not-an-array",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.createWorldFlow).not.toHaveBeenCalled();
  });
});
