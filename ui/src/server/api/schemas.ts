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
