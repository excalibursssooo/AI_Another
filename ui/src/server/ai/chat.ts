// Compatibility barrel for existing callers. Implementations live in focused modules.
export { isMockProvider, getActiveProviderInfo, getLanguageModel } from "./models";
export type { ModelPurpose, ActiveProviderInfo } from "./models";

export { generateChatReply, streamChatReply } from "./generators/chat-reply";
export type { ChatGenerationInput, GenerateChatReply, StreamChatReplyResult } from "./generators/chat-reply";

export { generateFeedPostDraft } from "./generators/feed-post";
export type { FeedPostDraftGenerationInput, GenerateFeedPostDraft } from "./generators/feed-post";

export { generateWorldDraft } from "./generators/world-draft";
export type { WorldDraftGenerationInput, GenerateWorldDraft } from "./generators/world-draft";

export { generateAgentDraft } from "./generators/agent-draft";
export type { AgentDraftGenerationInput, GenerateAgentDraft } from "./generators/agent-draft";

export { generateMemoryExtraction } from "./generators/memory-extraction";
export type { MemoryExtractionGenerationInput, GenerateMemoryExtraction } from "./generators/memory-extraction";
