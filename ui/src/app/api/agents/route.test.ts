import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentCreateFlow: vi.fn(),
  runAgentCreateFlow: vi.fn(),
  toAgentResponseDto: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/api/dto", () => ({
  toAgentResponseDto: mocks.toAgentResponseDto,
}));

vi.mock("@/server/domain/world/world-repository", () => ({
  WorldRepository: class {
    get() {
      return null;
    }
  },
}));

vi.mock("@/server/flow/agent-create-flow", () => ({
  createAgentCreateFlow: mocks.createAgentCreateFlow,
}));

import { POST } from "./route";

afterEach(() => {
  mocks.createAgentCreateFlow.mockReset();
  mocks.runAgentCreateFlow.mockReset();
  mocks.toAgentResponseDto.mockReset();
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

  it("uses the request user_id when creating the flow input", async () => {
    mocks.createAgentCreateFlow.mockReturnValue({ run: mocks.runAgentCreateFlow });
    mocks.runAgentCreateFlow.mockResolvedValue({
      agent: {
        id: "agent-1",
        worldId: "world-1",
      },
    });
    mocks.toAgentResponseDto.mockReturnValue({ id: "agent-1" });

    const response = await POST(
      agentRequest({
        user_id: "u-custom",
        name: "小伴",
        persona: "温和",
        background: "背景",
        domain_id: "world-1",
        hobbies: ["散步"],
        speaking_style: "自然",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runAgentCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "manual",
        userId: "u-custom",
        worldId: "world-1",
      }),
    );
  });
});
