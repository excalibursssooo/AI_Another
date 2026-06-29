import type { WorldMindDecision } from "./world-decision";

const WORLD_EVENT_TYPES = new Set([
  "user_action",
  "world_incident",
  "character_action",
  "relationship_shift",
  "knowledge_reveal",
  "fact_correction",
  "arc_progress",
  "system_note",
]);

const ACTOR_COMMAND_TYPES = new Set([
  "speak_to_user",
  "move_location",
  "investigate",
  "remember",
  "publish_post",
  "initiate_event",
]);

export function validateWorldMindDecision(input: {
  decision: WorldMindDecision;
  activeAgentIds: string[];
  hiddenFactSummaries: string[];
}): { ok: true; decision: WorldMindDecision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const { decision, activeAgentIds, hiddenFactSummaries } = input;

  // 1. Check duplicate clientEventId and known event types in events.
  const eventIds = new Set<string>();
  for (const ev of decision.events) {
    if (eventIds.has(ev.clientEventId)) {
      errors.push(`Duplicate clientEventId: ${ev.clientEventId}`);
    }
    if (!WORLD_EVENT_TYPES.has(ev.type)) {
      errors.push(`Unknown world event type: ${ev.type}`);
    }
    eventIds.add(ev.clientEventId);
  }

  // 2. Check each command's type and cause references.
  for (const cmd of decision.commands) {
    if (!ACTOR_COMMAND_TYPES.has(cmd.commandType)) {
      errors.push(`Unknown actor command type: ${cmd.commandType}`);
    }
    if (cmd.cause.type === "proposed_event" && !eventIds.has(cmd.cause.clientEventId)) {
      errors.push(`Command references unknown proposed event: ${cmd.cause.clientEventId}`);
    }
  }

  // 3. Check each command's targetAgentId is in activeAgentIds.
  const agentSet = new Set(activeAgentIds);
  for (const cmd of decision.commands) {
    if (!agentSet.has(cmd.targetAgentId)) {
      errors.push(`Command references unknown agent: ${cmd.targetAgentId}`);
    }
  }

  // 4. Check actorInstruction does not contain hidden fact summaries.
  for (const cmd of decision.commands) {
    for (const summary of hiddenFactSummaries) {
      if (summary && cmd.actorInstruction.includes(summary)) {
        errors.push(`Actor instruction leaks hidden fact: ${summary}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true, decision } : { ok: false, errors };
}
