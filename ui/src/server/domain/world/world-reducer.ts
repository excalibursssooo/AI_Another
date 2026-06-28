import type { UserActionPayload, WorldIncidentPayload, WorldReducerInput, WorldReductionResult, WorldRuntimeState } from "./types";

export function reduceWorldEvents(input: WorldReducerInput): WorldReductionResult {
  const ordered = [...input.events]
    .filter((event) => event.status === "committed")
    .sort((a, b) => a.sequence - b.sequence);
  const state: WorldRuntimeState = structuredClone(input.previousSnapshot.state);
  const appliedEventIds = [...input.previousSnapshot.appliedEventIds];
  let appliedEventSequence = input.previousSnapshot.appliedEventSequence;
  const warnings: string[] = [];

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
      applyWorldIncident(state, event.id, event.payload as WorldIncidentPayload);
    }
    appliedEventIds.push(event.id);
    appliedEventSequence = event.sequence;
  }

  return {
    appliedEventIds,
    warnings,
    worldSnapshot: {
      ...input.previousSnapshot,
      tick: input.previousSnapshot.tick,
      appliedEventSequence,
      appliedEventIds,
      reducerVersion: input.reducerVersion,
      state,
      updatedAt: Date.now(),
    },
  };
}

function applyWorldIncident(state: WorldRuntimeState, eventId: string, payload: WorldIncidentPayload): void {
  state.tension = clamp01(state.tension + (payload.tensionDelta ?? 0));
  state.stability = clamp01(state.stability + (payload.stabilityDelta ?? 0));
  if (payload.unresolved && !state.unresolvedEventIds.includes(eventId)) {
    state.unresolvedEventIds.push(eventId);
  }
  if (payload.factKey) {
    const exists = state.publicFacts.some((fact) => fact.factKey === payload.factKey);
    if (!exists) {
      state.publicFacts.push({
        factKey: payload.factKey,
        summary: payload.description,
        visibility: { level: "public", visibleToActorIds: [], visibleToUser: true },
        sourceEventId: eventId,
      });
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
