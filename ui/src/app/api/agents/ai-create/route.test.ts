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

function aiCreateRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/ai-create", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/agents/ai-create", () => {
  it("uses the request user_id when creating the flow input", async () => {
    mocks.createAgentCreateFlow.mockReturnValue({ run: mocks.runAgentCreateFlow });
    mocks.runAgentCreateFlow.mockResolvedValue({
      agent: {
        id: "agent-1",
        worldId: "world-1",
      },
      backend: "mock",
      model: "mock-model",
      rawText: "{}",
    });
    mocks.toAgentResponseDto.mockReturnValue({ id: "agent-1" });

    const response = await POST(
      aiCreateRequest({
        user_id: "u-custom",
        prompt: "生成一个朋友",
        domain_id: "world-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runAgentCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "ai",
        userId: "u-custom",
        worldId: "world-1",
        prompt: "生成一个朋友",
      }),
    );
  });
});
