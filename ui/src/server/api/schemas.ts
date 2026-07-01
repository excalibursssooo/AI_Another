import { z } from "zod";

const RequiredString = z.string().trim().min(1);
const OptionalString = z.string().trim().min(1).optional();

export const ChatRequestSchema = z.object({
  user_id: RequiredString,
  message: RequiredString,
  agent_id: RequiredString,
  domain_id: OptionalString,
  conversation_id: OptionalString,
  client_action_id: OptionalString,
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const DrainTasksRequestSchema = z.object({
  limit: z.number().int().min(0).max(100).optional(),
});

export type DrainTasksRequest = z.infer<typeof DrainTasksRequestSchema>;

export const AgentCreateRequestSchema = z.object({
  name: RequiredString,
  persona: RequiredString,
  background: z.string().trim().optional(),
  domain_id: z.string().trim().optional(),
  hobbies: z.array(RequiredString).optional(),
  speaking_style: z.string().trim().optional(),
});

export type AgentCreateRequest = z.infer<typeof AgentCreateRequestSchema>;

export const AgentUpdateRequestSchema = z.object({
  name: z.string().trim().optional(),
  persona: z.string().trim().optional(),
  background: z.string().trim().optional(),
  domain_id: z.string().trim().optional(),
  hobbies: z.array(z.string().trim()).optional(),
  speaking_style: z.string().trim().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;

export const WorldUpsertRequestSchema = z.object({
  id: z.string().trim().optional(),
  name: RequiredString,
  lore: z.string().trim().optional(),
  tone: z.string().trim().optional(),
  constraints: z.array(RequiredString).optional(),
  seed_memories: z.array(RequiredString).optional(),
});

export type WorldUpsertRequest = z.infer<typeof WorldUpsertRequestSchema>;

export const MemoryScopeRequestSchema = z.object({
  user_id: RequiredString,
  agent_id: RequiredString,
  domain_id: OptionalString,
});

export type MemoryScopeRequest = z.infer<typeof MemoryScopeRequestSchema>;

export const AgentAiCreateRequestSchema = z.object({
  prompt: z.string().trim().nullable().optional(),
  domain_id: z.string().trim().optional(),
});

export type AgentAiCreateRequest = z.infer<typeof AgentAiCreateRequestSchema>;

export const WorldAiCreateRequestSchema = z.object({
  prompt: z.string().trim().optional(),
  world_id: z.string().trim().optional(),
  base_domain_id: z.string().trim().optional(),
});

export type WorldAiCreateRequest = z.infer<typeof WorldAiCreateRequestSchema>;

export const FeedGenerateRequestSchema = z.object({
  user_id: z.string().trim().optional(),
  domain_id: z.string().trim().optional(),
  source_task_id: z.string().trim().nullable().optional(),
});

export type FeedGenerateRequest = z.infer<typeof FeedGenerateRequestSchema>;

export const AgentMemorySeedDebugRequestSchema = z.object({
  dry_run: z.boolean().optional(),
  force_reextract: z.boolean().optional(),
  user_id: z.string().trim().optional(),
  domain_id: z.string().trim().optional(),
});

export type AgentMemorySeedDebugRequest = z.infer<typeof AgentMemorySeedDebugRequestSchema>;
