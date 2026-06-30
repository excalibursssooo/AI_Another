import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainChatTasks: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/flow/task-worker", () => ({
  drainChatTasks: mocks.drainChatTasks,
}));

import { POST } from "./route";

describe("/api/internal/tasks/drain", () => {
  it("drains chat tasks through an explicit internal endpoint", async () => {
    mocks.drainChatTasks.mockResolvedValue({ processed: 2, failed: 1 });

    const response = await POST(
      new Request("http://localhost/api/internal/tasks/drain", {
        method: "POST",
        body: JSON.stringify({ limit: 5 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 2, failed: 1 });
    expect(mocks.drainChatTasks).toHaveBeenCalledWith({ db: { sqlite: {}, orm: {} }, limit: 5 });
  });
});
