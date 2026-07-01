import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

import { PUT } from "./route";

afterEach(() => {
  mocks.getDatabase.mockClear();
});

function agentUpdateRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/agent-1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function context(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

describe("/api/agents/[agentId] request validation", () => {
  it("returns 400 for invalid JSON before opening the database", async () => {
    const response = await PUT(
      new Request("http://localhost/api/agents/agent-1", {
        method: "PUT",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid status before opening the database", async () => {
    const response = await PUT(
      agentUpdateRequest({
        status: "deleted",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
