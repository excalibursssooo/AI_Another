import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

import { POST as activateMemory } from "./activate/route";
import { POST as freezeMemory } from "./freeze/route";
import { DELETE as deleteMemory } from "./route";

afterEach(() => {
  mocks.getDatabase.mockClear();
});

function memoryRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/memories/memory-1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function context(memoryId = "memory-1") {
  return { params: Promise.resolve({ memoryId }) };
}

describe("/api/memories/[memoryId] request validation", () => {
  it("returns 400 for invalid JSON before opening the database", async () => {
    const response = await deleteMemory(
      new Request("http://localhost/api/memories/memory-1", {
        method: "DELETE",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("returns 400 for blank freeze scope before opening the database", async () => {
    const response = await freezeMemory(
      memoryRequest({
        user_id: "  ",
        agent_id: "agent-1",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("returns 400 for blank activate scope before opening the database", async () => {
    const response = await activateMemory(
      memoryRequest({
        user_id: "u001",
        agent_id: "  ",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
