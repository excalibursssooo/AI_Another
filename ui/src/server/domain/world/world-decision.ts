import { z } from "zod";

export const VisibilityScopeSchema = z.object({
  mode: z.enum(["public", "private", "hidden"]),
  visibleToActorIds: z.array(z.string()).default([]),
  visibleToUser: z.boolean().default(false),
});

export type VisibilityScopeDecision = z.infer<typeof VisibilityScopeSchema>;

export const CommandCauseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposed_event"), clientEventId: z.string().min(1) }),
  z.object({ type: z.literal("committed_event"), eventId: z.string().min(1) }),
  z.object({ type: z.literal("source_action"), sourceActionId: z.string().min(1) }),
  z.object({ type: z.literal("director_no_event"), reasonCode: z.string().min(1) }),
]);

export type CommandCauseDecision = z.infer<typeof CommandCauseSchema>;

export const WorldMindIntentSchema = z.enum(["no_op", "advance_scene", "trigger_event", "dispatch_commands"]);

export const ProposedWorldEventSchema = z.object({
  clientEventId: z.string().min(1),
  type: z.enum([
    "world_incident",
    "character_action",
    "relationship_shift",
    "knowledge_reveal",
    "fact_correction",
    "arc_progress",
    "system_note",
  ]),
  payload: z.unknown(),
  visibility: VisibilityScopeSchema,
  actorIds: z.array(z.string()).default([]),
  locationKey: z.string().nullable().optional(),
  summary: z.string().min(1),
});

export type ProposedWorldEvent = z.infer<typeof ProposedWorldEventSchema>;

export const ProposedActorCommandSchema = z.object({
  commandType: z.enum(["speak_to_user", "move_location", "investigate", "remember", "publish_post", "initiate_event"]),
  targetAgentId: z.string().min(1),
  priority: z.enum(["low", "normal", "high"]),
  visibility: VisibilityScopeSchema,
  actorInstruction: z.string().min(1),
  privateReason: z.string().nullable(),
  cause: CommandCauseSchema,
  payload: z.unknown().default({}),
  relatedEventSummary: z.string().nullable().optional(),
});

export type ProposedActorCommand = z.infer<typeof ProposedActorCommandSchema>;

export const WorldMemoryCandidateSchema = z.object({
  subjectType: z.enum(["world", "arc", "faction", "location", "character", "user"]),
  subjectKey: z.string().min(1),
  memoryType: z.enum(["lore", "rule", "relationship", "secret", "unresolved_thread"]),
  canonicalKey: z.string().nullable(),
  content: z.string().min(1),
  visibility: VisibilityScopeSchema,
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceEventId: z.string().nullable(),
});

export type WorldMemoryCandidate = z.infer<typeof WorldMemoryCandidateSchema>;

export const WorldMindDecisionSchema = z.object({
  observations: z.array(z.string().min(1)).max(6),
  intent: WorldMindIntentSchema,
  events: z.array(ProposedWorldEventSchema).max(3),
  commands: z.array(ProposedActorCommandSchema).max(5),
  memories: z.array(WorldMemoryCandidateSchema).max(8),
  nextTick: z
    .object({
      delayMs: z.number().min(30_000).max(86_400_000),
      reason: z.string().min(1),
    })
    .nullable(),
});

export type WorldMindDecision = z.infer<typeof WorldMindDecisionSchema>;
