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

export const WorldUpsertRequestSchema = z.object({
  id: z.string().trim().optional(),
  name: RequiredString,
  lore: z.string().trim().optional(),
  tone: z.string().trim().optional(),
  constraints: z.array(RequiredString).optional(),
  seed_memories: z.array(RequiredString).optional(),
});

export type WorldUpsertRequest = z.infer<typeof WorldUpsertRequestSchema>;
