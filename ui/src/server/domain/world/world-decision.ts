import { z } from "zod";
import type { ActorCommandType, ActorCommandPriority } from "./types";

// Note: VisibilityScopeSchema uses `mode` field to match the brief's discriminated-union
// pattern, deviating from the existing `VisibilityScope.level` interface in types.ts.
export const VisibilityScopeSchema = z.object({
  mode: z.enum(["public", "private", "hidden"]),
  visibleToActorIds: z.array(z.string()).default([]),
});

export type VisibilityScope = z.infer<typeof VisibilityScopeSchema>;

export const CommandCauseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposed_event"), clientEventId: z.string() }),
  z.object({ type: z.literal("committed_event"), eventId: z.string() }),
  z.object({ type: z.literal("source_action"), sourceActionId: z.string() }),
  z.object({ type: z.literal("director_no_event"), reasonCode: z.string() }),
]);

export type CommandCause = z.infer<typeof CommandCauseSchema>;

export const ProposedWorldEventSchema = z.object({
  clientEventId: z.string(),
  type: z.string(),
  actorIds: z.array(z.string()),
  payload: z.unknown(),
  visibility: VisibilityScopeSchema,
  summary: z.string(),
});

export type ProposedWorldEvent = z.infer<typeof ProposedWorldEventSchema>;

export const ProposedActorCommandSchema = z.object({
  commandType: z.string() as z.ZodType<ActorCommandType>,
  targetAgentId: z.string(),
  priority: z.string() as z.ZodType<ActorCommandPriority>,
  visibility: VisibilityScopeSchema,
  visibleToUser: z.boolean(),
  actorInstruction: z.string(),
  privateReason: z.string().nullable(),
  cause: CommandCauseSchema,
  payload: z.unknown(),
  relatedEventSummary: z.string().nullable(),
});

export type ProposedActorCommand = z.infer<typeof ProposedActorCommandSchema>;

export const WorldMemoryCandidateSchema = z.object({
  subjectType: z.string(),
  subjectKey: z.string(),
  memoryType: z.string(),
  canonicalKey: z.string().nullable(),
  content: z.string(),
  visibility: VisibilityScopeSchema,
  visibleToUser: z.boolean(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceEventId: z.string().nullable(),
});

export type WorldMemoryCandidate = z.infer<typeof WorldMemoryCandidateSchema>;

export const WorldMindDecisionSchema = z.object({
  observations: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string(),
      }),
    )
    .max(6),
  proposedEvents: z.array(ProposedWorldEventSchema).max(3),
  proposedCommands: z.array(ProposedActorCommandSchema).max(5),
  memoryCandidates: z.array(WorldMemoryCandidateSchema).max(8),
  nextTick: z.object({
    delayMs: z.number().min(30_000).max(86_400_000),
    reason: z.string(),
  }),
});

export type WorldMindDecision = z.infer<typeof WorldMindDecisionSchema>;
