import type {
  CharacterStateRecord,
  UserActionPayload,
  VisibilityScope,
  WorldFact,
  WorldIncidentPayload,
  WorldReducerInput,
  WorldReductionResult,
  WorldRuntimeState,
} from "./types";

export function reduceWorldEvents(input: WorldReducerInput): WorldReductionResult {
  const ordered = [...input.events]
    .filter((event) => event.status === "committed")
    .sort((a, b) => a.sequence - b.sequence);
  const state: WorldRuntimeState = structuredClone(input.previousSnapshot.state);
  const appliedEventIds = [...input.previousSnapshot.appliedEventIds];
  let appliedEventSequence = input.previousSnapshot.appliedEventSequence;
  let appliedAnyEvent = false;
  const warnings: string[] = [];

  // Clone character states for mutation during reduction
  const characterStates: CharacterStateRecord[] = (input.previousCharacterStates ?? []).map((s) => ({
    ...s,
    knowledgeKeys: [...s.knowledgeKeys],
  }));

  for (const event of ordered) {
    if (event.sequence <= appliedEventSequence) {
      continue;
    }
    if (event.type === "user_action") {
      const payload = event.payload as UserActionPayload;
      if (payload.interpretationStatus === "observed_only") {
        // Audited input only. A later committed event must interpret it before it affects narrative state.
      }
    }
    if (event.type === "world_incident") {
      applyWorldIncident(state, event.id, event.payload as WorldIncidentPayload, event.visibility);
    }
    if (event.type === "knowledge_reveal") {
      const payload = event.payload as { factKey?: string };
      if (payload.factKey) {
        for (const char of characterStates) {
          if (event.actorIds.includes(char.agentId) && !char.knowledgeKeys.includes(payload.factKey)) {
            char.knowledgeKeys.push(payload.factKey);
          }
        }
      }
    }
    if (event.type === "character_action") {
      const payload = event.payload as { action?: string; locationKey?: string };
      if (payload.action === "move_location" && payload.locationKey) {
        for (const char of characterStates) {
          if (event.actorIds.includes(char.agentId)) {
            char.locationKey = payload.locationKey;
            char.lastActedAt = Date.now();
          }
        }
      }
    }
    appliedEventIds.push(event.id);
    appliedEventSequence = event.sequence;
    appliedAnyEvent = true;
  }

  return {
    appliedEventIds,
    warnings,
    characterStates,
    worldSnapshot: {
      ...input.previousSnapshot,
      tick: input.previousSnapshot.tick,
      appliedEventSequence,
      appliedEventIds,
      reducerVersion: input.reducerVersion,
      state,
      checksum: appliedAnyEvent ? null : input.previousSnapshot.checksum,
      updatedAt: Date.now(),
    },
  };
}

function applyWorldIncident(
  state: WorldRuntimeState,
  eventId: string,
  payload: WorldIncidentPayload,
  visibility: VisibilityScope,
): void {
  state.tension = clamp01(state.tension + (payload.tensionDelta ?? 0));
  state.stability = clamp01(state.stability + (payload.stabilityDelta ?? 0));
  if (payload.unresolved && !state.unresolvedEventIds.includes(eventId)) {
    state.unresolvedEventIds.push(eventId);
  }
  if (payload.factKey) {
    const targetFacts = selectFactBucket(state, visibility);
    const exists = targetFacts.some((fact) => fact.factKey === payload.factKey);
    if (!exists) {
      targetFacts.push({
        factKey: payload.factKey,
        summary: payload.description,
        visibility,
        sourceEventId: eventId,
      });
    }
  }
}

function selectFactBucket(state: WorldRuntimeState, visibility: VisibilityScope): WorldFact[] {
  if (visibility.mode === "public" && visibility.visibleToUser) {
    return state.publicFacts;
  }
  return state.hiddenFacts;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
