import { describe, expect, it, vi } from "vitest";

import { generateFeedPostAction, loadFeedPostsAction, triggerPostChatAction } from "./useFeedActions";
import type { PostItemDto } from "@/lib/api/types_api";
import type { AiAgent } from "@/features/chat/types";

const post: PostItemDto = {
  id: "post-1",
  user_id: "u001",
  agent_id: "agent-1",
  agent_name: "小伴",
  content: "今天想去散步。",
  topic_seed: "散步",
  post_type: "status",
  status: "published",
  source_task_id: null,
  created_at: "2026-07-01T00:00:00.000Z",
};

const agent: AiAgent = {
  id: "agent-1",
  name: "小伴",
  greeting: "你好",
  persona: "温和",
  background: "测试角色",
  domainId: "default",
  worldContext: "",
  hobbies: [],
  speakingStyle: "自然",
  status: "active",
  tagline: "温和",
  avatarColor: "#fff",
};

describe("feed action helpers", () => {
  it("loads feed posts with paging and domain filters", async () => {
    const loading: boolean[] = [];
    const posts: ReadonlyArray<PostItemDto>[] = [];
    const listPosts = vi.fn().mockResolvedValue({ items: [post], total: 1, limit: 20, offset: 0 });

    await loadFeedPostsAction({
      userId: "u001",
      selectedDomainId: "world-1",
      listPosts,
      setFeedLoading: (value) => loading.push(value),
      setFeedPosts: (value) => posts.push(value),
    });

    expect(listPosts).toHaveBeenCalledWith("u001", {
      limit: 20,
      offset: 0,
      includeArchived: false,
      domainId: "world-1",
      signal: undefined,
    });
    expect(posts).toEqual([[post]]);
    expect(loading).toEqual([true, false]);
  });

  it("skips loading when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const listPosts = vi.fn();

    await loadFeedPostsAction({
      userId: "u001",
      selectedDomainId: "world-1",
      signal: controller.signal,
      listPosts,
      setFeedLoading: vi.fn(),
      setFeedPosts: vi.fn(),
    });

    expect(listPosts).not.toHaveBeenCalled();
  });

  it("generates a feed post and refreshes the list", async () => {
    const generating: boolean[] = [];
    const notices: string[] = [];
    const generatePost = vi.fn().mockResolvedValue(undefined);
    const loadFeedPosts = vi.fn().mockResolvedValue(undefined);

    await generateFeedPostAction({
      selectedAgent: agent,
      isGeneratingPost: false,
      userId: "u001",
      generatePost,
      loadFeedPosts,
      setIsGeneratingPost: (value) => generating.push(value),
      setNotice: (message) => notices.push(message),
    });

    expect(generatePost).toHaveBeenCalledWith("agent-1", { user_id: "u001" });
    expect(loadFeedPosts).toHaveBeenCalledWith(undefined);
    expect(generating).toEqual([true, false]);
    expect(notices).toEqual(["已生成 小伴 的新动态"]);
  });

  it("injects a post topic into chat input", async () => {
    const selectedAgentIds: string[] = [];
    const inputs: string[] = [];
    const notices: string[] = [];
    const triggerChatFromPost = vi.fn().mockResolvedValue({
      post_id: "post-1",
      user_id: "u001",
      agent_id: "agent-1",
      suggested_message: "聊聊散步",
    });

    await triggerPostChatAction({
      post,
      userId: "u001",
      activeDomainId: "world-1",
      triggerChatFromPost,
      setSelectedAgentId: (value) => selectedAgentIds.push(value),
      setInput: (value) => inputs.push(value),
      setNotice: (message) => notices.push(message),
    });

    expect(triggerChatFromPost).toHaveBeenCalledWith("post-1", "u001", "world-1");
    expect(selectedAgentIds).toEqual(["agent-1"]);
    expect(inputs).toEqual(["聊聊散步"]);
    expect(notices).toEqual(["已注入话题，可直接发送"]);
  });
});
