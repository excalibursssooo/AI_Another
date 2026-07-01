import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
  createAgentCreateFlow: vi.fn(),
  createWorldFlow: vi.fn(),
  createFeedGenerateFlow: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("@/server/flow/agent-create-flow", () => ({
  createAgentCreateFlow: mocks.createAgentCreateFlow,
}));

vi.mock("@/server/flow/world-flow", () => ({
  createWorldFlow: mocks.createWorldFlow,
}));

vi.mock("@/server/flow/feed-flow", () => ({
  createFeedGenerateFlow: mocks.createFeedGenerateFlow,
}));

import { POST as aiCreateAgent } from "@/app/api/agents/ai-create/route";
import { POST as generatePost } from "@/app/api/agents/[agentId]/generate-post/route";
import { POST as seedMemoryDebug } from "@/app/api/agents/[agentId]/memory-seed/debug/route";
import { POST as aiCreateWorld } from "@/app/api/worlds/ai-create/route";

afterEach(() => {
  mocks.getDatabase.mockClear();
  mocks.createAgentCreateFlow.mockReset();
  mocks.createWorldFlow.mockReset();
  mocks.createFeedGenerateFlow.mockReset();
});

function invalidJsonRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    body: "{",
    headers: { "Content-Type": "application/json" },
  });
}

function agentContext(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

describe("optional JSON body route validation", () => {
  it("rejects malformed JSON for AI agent creation before creating the flow", async () => {
    const response = await aiCreateAgent(invalidJsonRequest("http://localhost/api/agents/ai-create"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createAgentCreateFlow).not.toHaveBeenCalled();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON for AI world creation before creating the flow", async () => {
    const response = await aiCreateWorld(invalidJsonRequest("http://localhost/api/worlds/ai-create"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createWorldFlow).not.toHaveBeenCalled();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON for feed generation before creating the flow", async () => {
    const response = await generatePost(
      invalidJsonRequest("http://localhost/api/agents/agent-1/generate-post"),
      agentContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createFeedGenerateFlow).not.toHaveBeenCalled();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON for memory seed debug before opening the database", async () => {
    const response = await seedMemoryDebug(
      invalidJsonRequest("http://localhost/api/agents/agent-1/memory-seed/debug"),
      agentContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
