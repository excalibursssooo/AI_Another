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
