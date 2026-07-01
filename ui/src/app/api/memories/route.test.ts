import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
  listMemories: vi.fn(() => []),
  toMemoryResponseDto: vi.fn((memory: unknown) => memory),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("@/server/domain/memory/memory-repository", () => ({
  MemoryRepository: class {
    list = mocks.listMemories;
  },
}));

vi.mock("@/server/api/dto", () => ({
  toMemoryResponseDto: mocks.toMemoryResponseDto,
}));

import { GET } from "./route";

afterEach(() => {
  mocks.getDatabase.mockClear();
  mocks.listMemories.mockReset();
  mocks.toMemoryResponseDto.mockClear();
});

describe("/api/memories query validation", () => {
  it("returns 400 when user_id is missing before opening the database", async () => {
    const response = await GET(new Request("http://localhost/api/memories?agent_id=agent-default"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.listMemories).not.toHaveBeenCalled();
  });

  it("uses the request user_id when listing memories", async () => {
    mocks.listMemories.mockReturnValue([
      {
        id: "mem-1",
        userId: "u-custom",
        agentId: "agent-default",
        worldId: "default",
      },
    ]);

    const response = await GET(
      new Request("http://localhost/api/memories?user_id=u-custom&agent_id=agent-default&domain_id=default"),
    );

    expect(response.status).toBe(200);
    expect(mocks.listMemories).toHaveBeenCalledWith({
      userId: "u-custom",
      agentId: "agent-default",
      worldId: "default",
      status: "all",
    });
  });
});
