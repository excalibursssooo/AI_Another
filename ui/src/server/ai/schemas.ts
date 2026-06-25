import { z } from "zod";

export const MoodSchema = z.object({
  label: z.enum(["calm", "happy", "sad", "anxious", "angry", "focused", "neutral", "high_risk"]),
  intensity: z.number().min(0).max(1),
  heartbeatBpm: z.number().int().min(55).max(130),
});

export const ChatReplySchema = z.object({
  reply: z.string().min(1),
  mood: MoodSchema,
});

export type ChatReply = z.infer<typeof ChatReplySchema>;

export const AgentDraftSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  persona: z.string().min(1),
  background: z.string(),
  greeting: z.string(),
  speakingStyle: z.string(),
  hobbies: z.array(z.string()),
});

export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export const WorldDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lore: z.string(),
  tone: z.string(),
  constraints: z.array(z.string()),
  seedMemories: z.array(z.string()),
});

export type WorldDraft = z.infer<typeof WorldDraftSchema>;
