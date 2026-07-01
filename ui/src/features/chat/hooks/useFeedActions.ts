import { useCallback, useState } from "react";

import { generatePost, listPosts, triggerChatFromPost } from "@/lib/api/companion";
import type { GeneratePostResponseDto, PostItemDto, PostListDto, TriggerChatFromPostDto } from "@/lib/api/types_api";
import { getErrorMessage } from "@/lib/utils/error";
import type { AiAgent } from "@/features/chat/types";
import { useFeedPolling } from "@/features/chat/hooks/useFeedPolling";

type SetNotice = (message: string) => void;

interface LoadFeedPostsActionOptions {
  userId: string;
  selectedDomainId: string;
  signal?: AbortSignal;
  listPosts: (
    userId: string,
    options: {
      limit: number;
      offset: number;
      includeArchived: boolean;
      domainId: string;
      signal?: AbortSignal;
    },
  ) => Promise<PostListDto>;
  setFeedLoading: (value: boolean) => void;
  setFeedPosts: (value: PostItemDto[]) => void;
}

interface GenerateFeedPostActionOptions {
  selectedAgent: AiAgent | undefined;
  isGeneratingPost: boolean;
  userId: string;
  generatePost: (agentId: string, payload: { user_id: string }) => Promise<GeneratePostResponseDto>;
  loadFeedPosts: (signal?: AbortSignal) => Promise<void>;
  setIsGeneratingPost: (value: boolean) => void;
  setNotice: SetNotice;
}

interface TriggerPostChatActionOptions {
  post: PostItemDto;
  userId: string;
  activeDomainId: string;
  triggerChatFromPost: (postId: string, userId: string, domainId: string) => Promise<TriggerChatFromPostDto>;
  setSelectedAgentId: (agentId: string) => void;
  setInput: (value: string) => void;
  setNotice: SetNotice;
}

interface UseFeedActionsOptions {
  userId: string;
  selectedDomainId: string;
  activeDomainId: string;
  selectedAgent: AiAgent | undefined;
  setSelectedAgentId: (agentId: string) => void;
  setInput: (value: string) => void;
  onNotice: SetNotice;
}

export async function loadFeedPostsAction(options: LoadFeedPostsActionOptions): Promise<void> {
  if (options.signal?.aborted) {
    return;
  }

  options.setFeedLoading(true);
  try {
    const rows = await options.listPosts(options.userId, {
      limit: 20,
      offset: 0,
      includeArchived: false,
      domainId: options.selectedDomainId,
      signal: options.signal,
    });
    if (options.signal?.aborted) {
      return;
    }
    options.setFeedPosts([...rows.items]);
  } finally {
    if (!options.signal?.aborted) {
      options.setFeedLoading(false);
    }
  }
}

export async function generateFeedPostAction(options: GenerateFeedPostActionOptions): Promise<void> {
  if (!options.selectedAgent || options.isGeneratingPost) {
    return;
  }

  options.setIsGeneratingPost(true);
  try {
    await options.generatePost(options.selectedAgent.id, { user_id: options.userId });
    try {
      await options.loadFeedPosts(undefined);
    } catch (error) {
      options.setNotice(`动态加载失败: ${getErrorMessage(error)}`);
    }
    options.setNotice(`已生成 ${options.selectedAgent.name} 的新动态`);
  } catch (error) {
    options.setNotice(`动态生成失败: ${getErrorMessage(error)}`);
  } finally {
    options.setIsGeneratingPost(false);
  }
}

export async function triggerPostChatAction(options: TriggerPostChatActionOptions): Promise<void> {
  try {
    const payload = await options.triggerChatFromPost(options.post.id, options.userId, options.activeDomainId);
    options.setSelectedAgentId(payload.agent_id);
    options.setInput(payload.suggested_message);
    options.setNotice("已注入话题，可直接发送");
  } catch (error) {
    options.setNotice(`话题注入失败: ${getErrorMessage(error)}`);
  }
}

export function useFeedActions(options: UseFeedActionsOptions) {
  const [feedPosts, setFeedPosts] = useState<PostItemDto[]>([]);
  const [feedLoading, setFeedLoading] = useState<boolean>(false);
  const [isGeneratingPost, setIsGeneratingPost] = useState<boolean>(false);

  const loadFeedPosts = useCallback(
    async (signal?: AbortSignal) => {
      await loadFeedPostsAction({
        userId: options.userId,
        selectedDomainId: options.selectedDomainId,
        signal,
        listPosts,
        setFeedLoading,
        setFeedPosts,
      });
    },
    [options.selectedDomainId, options.userId],
  );

  useFeedPolling(loadFeedPosts);

  const onGeneratePost = useCallback(async () => {
    await generateFeedPostAction({
      selectedAgent: options.selectedAgent,
      isGeneratingPost,
      userId: options.userId,
      generatePost,
      loadFeedPosts,
      setIsGeneratingPost,
      setNotice: options.onNotice,
    });
  }, [isGeneratingPost, loadFeedPosts, options.onNotice, options.selectedAgent, options.userId]);

  const onTriggerFromPost = useCallback(
    async (post: PostItemDto) => {
      await triggerPostChatAction({
        post,
        userId: options.userId,
        activeDomainId: options.activeDomainId,
        triggerChatFromPost,
        setSelectedAgentId: options.setSelectedAgentId,
        setInput: options.setInput,
        setNotice: options.onNotice,
      });
    },
    [options.activeDomainId, options.onNotice, options.setInput, options.setSelectedAgentId, options.userId],
  );

  return {
    feedPosts,
    feedLoading,
    isGeneratingPost,
    loadFeedPosts,
    onGeneratePost,
    onTriggerFromPost,
  };
}
