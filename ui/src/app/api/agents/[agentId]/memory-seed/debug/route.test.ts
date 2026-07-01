import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("@/server/domain/agent/agent-repository", () => ({
  AgentRepository: class {
    get() {
      return null;
    }
  },
}));

import { POST } from "./route";

afterEach(() => {
  mocks.getDatabase.mockClear();
});

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/agent-1/memory-seed/debug", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function agentContext(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

describe("/api/agents/[agentId]/memory-seed/debug", () => {
  it("requires user_id before opening the database", async () => {
    const response = await POST(
      request({
        dry_run: true,
      }),
      agentContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
