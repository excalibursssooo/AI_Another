import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentCreateFlow: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/flow/agent-create-flow", () => ({
  createAgentCreateFlow: mocks.createAgentCreateFlow,
}));

import { POST } from "./route";

afterEach(() => {
  mocks.createAgentCreateFlow.mockReset();
});

function agentRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/agents request validation", () => {
  it("returns 400 for invalid JSON before creating the flow", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createAgentCreateFlow).not.toHaveBeenCalled();
  });

  it("returns 400 for blank required fields before creating the flow", async () => {
    const response = await POST(
      agentRequest({
        name: "  ",
        persona: "  ",
        hobbies: "not-an-array",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.createAgentCreateFlow).not.toHaveBeenCalled();
  });
});
