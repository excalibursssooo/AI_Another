export type VisibilityLevel = "public" | "private" | "hidden";

export interface VisibilityScope {
  level: VisibilityLevel;
  visibleToActorIds: string[];
  visibleToUser: boolean;
}

export type WorldEventType =
  | "user_action"
  | "world_incident"
  | "character_action"
  | "relationship_shift"
  | "knowledge_reveal"
  | "arc_progress"
  | "system_note";

export type WorldEventStatus = "committed" | "rejected" | "superseded";

export interface UserActionPayload {
  clientActionId: string;
  normalizedMessage: string;
  targetAgentId: string;
  interpretationStatus: "pending" | "accepted" | "observed_only";
  failureReason?: "model_failed" | "validation_failed";
}

export interface WorldIncidentPayload {
  title: string;
  description: string;
  tensionDelta?: number;
  stabilityDelta?: number;
  unresolved?: boolean;
  factKey?: string;
}

export interface WorldFact {
  factKey: string;
  summary: string;
  visibility: VisibilityScope;
  sourceEventId: string;
}

export interface WorldRuntimeState {
  clock: {
    day: number;
    phase: "dawn" | "day" | "dusk" | "night";
    updatedAt: number;
  };
  stability: number;
  tension: number;
  activeArcIds: string[];
  publicFacts: WorldFact[];
  hiddenFacts: WorldFact[];
  unresolvedEventIds: string[];
}

export interface WorldEventRecord {
  id: string;
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  tick: number;
  sequence: number;
  schemaVersion: number;
  reducerVersion: number;
  type: WorldEventType;
  payload: unknown;
  summary: string;
  visibility: VisibilityScope;
  actorIds: string[];
  locationKey: string | null;
  causedByEventId: string | null;
  causedByUserActionId: string | null;
  idempotencyKey: string;
  status: WorldEventStatus;
  createdAt: number;
}

export interface WorldStateSnapshotRecord {
  id: string;
  userId: string;
  worldId: string;
  tick: number;
  snapshotKind: "latest" | "checkpoint" | "rebuild";
  isLatest: boolean;
  appliedEventSequence: number;
  appliedEventIds: string[];
  reducerVersion: number;
  state: WorldRuntimeState;
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorldReducerInput {
  previousSnapshot: WorldStateSnapshotRecord;
  events: WorldEventRecord[];
  reducerVersion: number;
}

export interface WorldReductionResult {
  worldSnapshot: WorldStateSnapshotRecord;
  appliedEventIds: string[];
  warnings: string[];
}

export const PUBLIC_VISIBILITY: VisibilityScope = {
  level: "public",
  visibleToActorIds: [],
  visibleToUser: true,
};
