import { z } from "zod";
import type { WorldMindDecision, ProposedWorldEvent } from "./world-decision";

const WorldIncidentPayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tensionDelta: z.number().min(-1).max(1).optional(),
  stabilityDelta: z.number().min(-1).max(1).optional(),
  unresolved: z.boolean().optional(),
  factKey: z.string().min(1).optional(),
  chainReaction: z.boolean().optional(),
});

const KnowledgeRevealPayloadSchema = z.object({
  factKey: z.string().min(1),
  summary: z.string().min(1).optional(),
});

const CharacterActionPayloadSchema = z.object({
  action: z.enum(["move_location", "investigate", "remember", "speak", "initiate_event"]),
  locationKey: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
});

const RelationshipShiftPayloadSchema = z.object({
  targetAgentId: z.string().min(1).optional(),
  affinityDelta: z.number().min(-1).max(1).optional(),
  trustDelta: z.number().min(-1).max(1).optional(),
  tensionDelta: z.number().min(-1).max(1).optional(),
});

const ArcProgressPayloadSchema = z.object({
  patchType: z.enum(["resolve_thread", "advance_arc", "open_thread"]),
  threadKey: z.string().min(1).optional(),
  arcId: z.string().min(1).optional(),
  resolution: z.string().min(1).optional(),
  chainReaction: z.boolean().optional(),
});

const FactCorrectionPayloadSchema = z.object({
  factKey: z.string().min(1),
  correction: z.string().min(1),
  correctedEventId: z.string().min(1).optional(),
});

const SystemNotePayloadSchema = z.object({
  note: z.string().min(1),
});

export function validateWorldMindDecision(input: {
  decision: WorldMindDecision;
  activeAgentIds: string[];
  hiddenFactSummaries: string[];
  sourceType?: "user_action" | "scheduled_tick" | "system_trigger";
}): { ok: true; decision: WorldMindDecision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const eventIds = new Set<string>();
  const activeAgents = new Set(input.activeAgentIds);

  for (const event of input.decision.events) {
    if (eventIds.has(event.clientEventId)) {
      errors.push(`Duplicate clientEventId: ${event.clientEventId}`);
    }
    eventIds.add(event.clientEventId);

    for (const actorId of event.actorIds) {
      if (!activeAgents.has(actorId)) {
        errors.push(`Event ${event.clientEventId} references unknown actor: ${actorId}`);
      }
    }

    validateEventPayload(event, errors);
    rejectHiddenLeakage({
      text: `${event.summary}\n${JSON.stringify(event.payload)}`,
      visibilityMode: event.visibility.mode,
      hiddenFactSummaries: input.hiddenFactSummaries,
      errors,
      label: `Event ${event.clientEventId}`,
    });
  }

  for (const command of input.decision.commands) {
    if (!activeAgents.has(command.targetAgentId)) {
      errors.push(`Command references unknown agent: ${command.targetAgentId}`);
    }
    if (command.cause.type === "proposed_event" && !eventIds.has(command.cause.clientEventId)) {
      errors.push(`Command references unknown proposed event: ${command.cause.clientEventId}`);
    }
    if (command.commandType === "speak_to_user" && !isActorVisibleCommand(command)) {
      errors.push(`speak_to_user command for ${command.targetAgentId} must be actor-visible`);
    }
    rejectHiddenLeakage({
      text: command.actorInstruction,
      visibilityMode: command.visibility.mode,
      hiddenFactSummaries: input.hiddenFactSummaries,
      errors,
      label: `Command for ${command.targetAgentId}`,
    });
  }

  if ((input.sourceType ?? "user_action") === "user_action") {
    const majorEvents = input.decision.events.filter(
      (event) => event.type === "world_incident" || event.type === "arc_progress",
    );
    const hasChainReaction = input.decision.events.some((event) => {
      const payload = event.payload as { chainReaction?: unknown };
      return payload.chainReaction === true;
    });
    if (majorEvents.length > 1 && !hasChainReaction) {
      errors.push("User actions may create at most one major event unless an event is marked as a chain reaction");
    }
  }

  return errors.length === 0 ? { ok: true, decision: input.decision } : { ok: false, errors };
}

function isActorVisibleCommand(command: WorldMindDecision["commands"][number]): boolean {
  if (command.visibility.mode === "public") {
    return true;
  }
  if (command.visibility.mode === "private") {
    return command.visibility.visibleToActorIds.includes(command.targetAgentId);
  }
  return false;
}

function validateEventPayload(event: ProposedWorldEvent, errors: string[]): void {
  const schemaByType: Record<string, z.ZodTypeAny> = {
    world_incident: WorldIncidentPayloadSchema,
    character_action: CharacterActionPayloadSchema,
    relationship_shift: RelationshipShiftPayloadSchema,
    knowledge_reveal: KnowledgeRevealPayloadSchema,
    fact_correction: FactCorrectionPayloadSchema,
    arc_progress: ArcProgressPayloadSchema,
    system_note: SystemNotePayloadSchema,
  };

  const schema = schemaByType[event.type];
  if (!schema) {
    errors.push(`Unknown event type: ${event.type}`);
    return;
  }

  const result = schema.safeParse(event.payload);
  if (!result.success) {
    errors.push(
      `${event.type} payload for ${event.clientEventId} is invalid: ${result.error.issues
        .map((issue) => issue.path.join(".") || issue.message)
        .join(", ")}`,
    );
  }
}

function rejectHiddenLeakage(input: {
  text: string;
  visibilityMode: "public" | "private" | "hidden";
  hiddenFactSummaries: string[];
  errors: string[];
  label: string;
}): void {
  if (input.visibilityMode === "hidden") {
    return;
  }
  const normalizedText = input.text.toLowerCase();
  for (const summary of input.hiddenFactSummaries) {
    const normalizedSummary = summary.trim().toLowerCase();
    if (normalizedSummary.length >= 8 && normalizedText.includes(normalizedSummary)) {
      input.errors.push(`${input.label} leaks hidden fact: ${summary}`);
    }
  }
}
