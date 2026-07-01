import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatFlow: vi.fn(),
  createWorldInteractionFlow: vi.fn(),
  drainChatTasks: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
}));

vi.mock("@/server/flow/world-interaction-flow", () => ({
  createWorldInteractionFlow: mocks.createWorldInteractionFlow,
}));

vi.mock("@/server/flow/chat-flow", () => ({
  createChatFlow: mocks.createChatFlow,
}));

vi.mock("@/server/flow/task-worker", () => ({
  drainChatTasks: mocks.drainChatTasks,
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.createChatFlow.mockReset();
  mocks.createWorldInteractionFlow.mockReset();
  mocks.drainChatTasks.mockReset();
});

function chatRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/chat request validation", () => {
  it("returns 400 for invalid JSON before creating flows", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
    expect(mocks.createChatFlow).not.toHaveBeenCalled();
    expect(mocks.createWorldInteractionFlow).not.toHaveBeenCalled();
  });

  it("returns 400 for blank required fields before creating flows", async () => {
    const response = await POST(
      chatRequest({
        user_id: "u001",
        agent_id: "agent-default",
        message: "   ",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.createChatFlow).not.toHaveBeenCalled();
    expect(mocks.createWorldInteractionFlow).not.toHaveBeenCalled();
  });

  it("returns 400 for deprecated conversation_id before creating flows", async () => {
    const response = await POST(
      chatRequest({
        user_id: "u001",
        agent_id: "agent-default",
        message: "hello",
        conversation_id: "conv-legacy",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.createChatFlow).not.toHaveBeenCalled();
    expect(mocks.createWorldInteractionFlow).not.toHaveBeenCalled();
  });
});

describe("/api/chat WorldMind branch", () => {
  it("returns 400 before creating a WorldMind run when client_action_id is missing", async () => {
    vi.stubEnv("ENABLE_WORLD_MIND", "true");

    const response = await POST(
      chatRequest({
        user_id: "u001",
        agent_id: "agent-default",
        domain_id: "default",
        message: "hello",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing client_action_id" });
    expect(mocks.createWorldInteractionFlow).not.toHaveBeenCalled();
  });

  it("keeps the SSE done-error contract when WorldInteractionFlow fails", async () => {
    vi.stubEnv("ENABLE_WORLD_MIND", "true");
    mocks.createWorldInteractionFlow.mockRejectedValue(new Error("world not found: missing-world"));

    const response = await POST(
      chatRequest({
        user_id: "u001",
        agent_id: "agent-default",
        domain_id: "missing-world",
        message: "hello",
        client_action_id: "client-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"error":"world not found: missing-world"');
  });
});

describe("/api/chat standard branch", () => {
  it("returns chat SSE without draining background tasks", async () => {
    mocks.createChatFlow.mockReturnValue({
      run: vi.fn().mockResolvedValue({
        reply: "hello back",
        doneEvent: {
          type: "done",
          agent_id: "agent-default",
          agent_name: "Agent",
          emotion_label: "calm",
          mood_intensity: 0.3,
          heartbeat_bpm: 72,
          risk_level: "low",
          recalled_memories: [],
          persisted_memory_count: 0,
        },
      }),
    });

    const response = await POST(
      chatRequest({
        user_id: "u001",
        agent_id: "agent-default",
        domain_id: "default",
        message: "hello",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"content":"hello back"');
    expect(mocks.drainChatTasks).not.toHaveBeenCalled();
  });
});
