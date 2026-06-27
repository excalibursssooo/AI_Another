import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  persona: text("persona").notNull(),
  background: text("background").notNull(),
  greeting: text("greeting").notNull(),
  speakingStyle: text("speaking_style").notNull(),
  hobbiesJson: text("hobbies_json").notNull().default("[]"),
  worldId: text("world_id").notNull().default("default"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const worlds = sqliteTable("worlds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lore: text("lore").notNull().default(""),
  tone: text("tone").notNull().default(""),
  constraintsJson: text("constraints_json").notNull().default("[]"),
  seedMemoriesJson: text("seed_memories_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull().default("default"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull().default("default"),
  subject: text("subject").notNull(),
  memoryType: text("memory_type").notNull(),
  content: text("content").notNull(),
  importance: real("importance").notNull().default(0.5),
  confidence: real("confidence").notNull().default(0.5),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at"),
  canonicalKey: text("canonical_key"),
  topic: text("topic"),
  embeddingJson: text("embedding_json"),
  embeddingModel: text("embedding_model"),
  embeddingBackend: text("embedding_backend"),
  embeddingQuality: text("embedding_quality"),
  embeddingDimension: integer("embedding_dimension"),
  embeddingStatus: text("embedding_status").notNull().default("missing"),
  embeddingTextHash: text("embedding_text_hash"),
  embeddingVersion: integer("embedding_version").notNull().default(1),
  embeddingNeedsRefresh: integer("embedding_needs_refresh").notNull().default(1),
  embeddingUpdatedAt: integer("embedding_updated_at"),
  supersededBy: text("superseded_by"),
  supersededReason: text("superseded_reason"),
  lastObservedAt: integer("last_observed_at"),
  sourceMessageId: text("source_message_id"),
  sourceTaskId: text("source_task_id"),
});

export const agentLiveStates = sqliteTable(
  "agent_live_states",
  {
    agentId: text("agent_id").notNull(),
    userId: text("user_id").notNull(),
    agentName: text("agent_name").notNull(),
    moodLabel: text("mood_label").notNull(),
    moodIntensity: real("mood_intensity").notNull(),
    heartbeatBpm: integer("heartbeat_bpm").notNull(),
    riskLevel: text("risk_level").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const feedPosts = sqliteTable("feed_posts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  worldId: text("world_id").notNull().default("default"),
  content: text("content").notNull(),
  topicSeed: text("topic_seed").notNull(),
  postType: text("post_type").notNull().default("status"),
  status: text("status").notNull().default("published"),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  runAfter: integer("run_after").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memoriesFts = sqliteTable("memories_fts", {
  rowid: integer("rowid").notNull(),
  content: text("content").notNull(),
});

export const memoryOperationLogs = sqliteTable("memory_operation_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  worldId: text("world_id").notNull(),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at").notNull(),
});

export const feedTopics = sqliteTable("feed_topics", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  worldId: text("world_id").notNull(),
  agentId: text("agent_id").notNull().default("__shared__"),
  topicKey: text("topic_key").notNull(),
  representativeEmbeddingJson: text("representative_embedding_json").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingQuality: text("embedding_quality").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  useCount: integer("use_count").notNull().default(1),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
});
