import type { WorldMindDecision } from "./world-decision";

export function validateWorldMindDecision(input: {
  decision: WorldMindDecision;
  activeAgentIds: string[];
  hiddenFactSummaries: string[];
}): { ok: true; decision: WorldMindDecision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const { decision, activeAgentIds, hiddenFactSummaries } = input;

  // 1. Check duplicate clientEventId in proposedEvents.
  const eventIds = new Set<string>();
  for (const ev of decision.proposedEvents) {
    if (eventIds.has(ev.clientEventId)) {
      errors.push(`Duplicate clientEventId: ${ev.clientEventId}`);
    }
    eventIds.add(ev.clientEventId);
  }

  // 2. Check each command's cause references a valid proposed event (if proposed_event).
  for (const cmd of decision.proposedCommands) {
    if (cmd.cause.type === "proposed_event" && !eventIds.has(cmd.cause.clientEventId)) {
      errors.push(`Command references unknown proposed event: ${cmd.cause.clientEventId}`);
    }
  }

  // 3. Check each command's targetAgentId is in activeAgentIds.
  const agentSet = new Set(activeAgentIds);
  for (const cmd of decision.proposedCommands) {
    if (!agentSet.has(cmd.targetAgentId)) {
      errors.push(`Command references unknown agent: ${cmd.targetAgentId}`);
    }
  }

  // 4. Check public actorInstruction does not contain hidden fact summaries.
  for (const cmd of decision.proposedCommands) {
    if (cmd.visibility.mode === "public") {
      for (const summary of hiddenFactSummaries) {
        if (cmd.actorInstruction.includes(summary)) {
          errors.push(`Public actorInstruction leaks hidden fact: ${summary}`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true, decision } : { ok: false, errors };
}
