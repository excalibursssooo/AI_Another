import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ sqlite: {}, orm: {} })),
  createFeedGenerateFlow: vi.fn(),
  createPostTrigger: vi.fn(),
  listPosts: vi.fn(() => ({ items: [], total: 0 })),
  recentMessagesForScope: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getLiveState: vi.fn(() => ({
    userId: "u001",
    agentId: "agent-1",
    agentName: "agent-1",
    moodLabel: "neutral",
    moodIntensity: 0.2,
    heartbeatBpm: 72,
    riskLevel: "low",
    updatedAt: 1,
  })),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("@/server/flow/feed-flow", () => ({
  createFeedGenerateFlow: mocks.createFeedGenerateFlow,
  createPostTrigger: mocks.createPostTrigger,
}));

vi.mock("@/server/domain/feed/feed-post-repository", () => ({
  FeedPostRepository: class {
    list = mocks.listPosts;
  },
}));

vi.mock("@/server/domain/conversation/conversation-repository", () => ({
  ConversationRepository: class {
    recentMessagesForScope = mocks.recentMessagesForScope;
  },
}));

vi.mock("@/server/domain/agent/agent-repository", () => ({
  AgentRepository: class {
    get = mocks.getAgent;
  },
}));

vi.mock("@/server/domain/live-state/agent-live-state-repository", () => ({
  AgentLiveStateRepository: class {
    get = mocks.getLiveState;
  },
}));

vi.mock("@/server/api/dto", () => ({
  toAgentLiveStateDto: vi.fn((state: unknown) => state),
  toConversationTurnDto: vi.fn((turn: unknown) => turn),
  toPostItemDto: vi.fn((post: unknown) => post),
}));

import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as listPosts } from "@/app/api/posts/route";
import { POST as triggerPostChat } from "@/app/api/posts/[postId]/trigger-chat/route";
import { GET as getLiveState } from "@/app/api/agents/[agentId]/state/live/route";
import { POST as generatePost } from "@/app/api/agents/[agentId]/generate-post/route";

afterEach(() => {
  mocks.getDatabase.mockClear();
  mocks.createFeedGenerateFlow.mockReset();
  mocks.createPostTrigger.mockReset();
  mocks.listPosts.mockReset();
  mocks.listPosts.mockReturnValue({ items: [], total: 0 });
  mocks.recentMessagesForScope.mockReset();
  mocks.recentMessagesForScope.mockReturnValue([]);
  mocks.getAgent.mockReset();
  mocks.getAgent.mockReturnValue(null);
  mocks.getLiveState.mockClear();
});

function agentContext(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

function postContext(postId = "post-1") {
  return { params: Promise.resolve({ postId }) };
}

describe("API user scope validation", () => {
  it("requires user_id when listing conversations", async () => {
    const response = await listConversations(
      new Request("http://localhost/api/conversations?agent_id=agent-default"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("requires user_id when listing posts", async () => {
    const response = await listPosts(new Request("http://localhost/api/posts"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("requires user_id when triggering chat from a post", async () => {
    const response = await triggerPostChat(new Request("http://localhost/api/posts/post-1/trigger-chat"), postContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.createPostTrigger).not.toHaveBeenCalled();
  });

  it("requires user_id when reading live state", async () => {
    const response = await getLiveState(new Request("http://localhost/api/agents/agent-1/state/live"), agentContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("requires user_id when generating a feed post", async () => {
    const response = await generatePost(
      new Request("http://localhost/api/agents/agent-1/generate-post", {
        method: "POST",
        body: JSON.stringify({ domain_id: "default" }),
        headers: { "Content-Type": "application/json" },
      }),
      agentContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.createFeedGenerateFlow).not.toHaveBeenCalled();
  });
});
