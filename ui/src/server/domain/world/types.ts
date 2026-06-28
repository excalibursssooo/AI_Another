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
  | "fact_correction"
  | "arc_progress"
  | "system_note";

export type WorldEventStatus = "committed";

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

export type WorldRunSourceType = "user_action" | "scheduled_tick" | "system_trigger";
export type WorldRunStatus = "running" | "committed" | "failed" | "rejected";

export interface WorldRunEnvelope {
  worldRunId: string;
  decisionId: string;
  sourceType: WorldRunSourceType;
  sourceActionId: string;
  idempotencyKey: string;
  userId: string;
  worldId: string;
  agentId?: string;
  status: WorldRunStatus;
  resultJson: string | null;
  startedAt: number;
}

export interface CharacterStateRecord {
  userId: string;
  worldId: string;
  agentId: string;
  locationKey: string;
  currentGoal: string;
  emotionalState: { label: string; intensity: number };
  relationshipToUser: { affinity: number; trust: number; tension: number };
  knowledgeKeys: string[];
  activeCommandId: string | null;
  lastActedAt: number | null;
  updatedAt: number;
}

export type ActorCommandType =
  | "speak_to_user"
  | "move_location"
  | "investigate"
  | "remember"
  | "publish_post"
  | "initiate_event";
export type ActorCommandPriority = "low" | "normal" | "high";
export type ActorCommandStatus = "pending" | "claimed" | "done" | "failed" | "expired";

export type CommandCause =
  | { type: "proposed_event"; clientEventId: string }
  | { type: "committed_event"; eventId: string }
  | { type: "source_action"; sourceActionId: string }
  | { type: "director_no_event"; reasonCode: string };

export interface ActorCommandRecord {
  id: string;
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  targetAgentId: string;
  commandType: ActorCommandType;
  priority: ActorCommandPriority;
  visibility: VisibilityScope;
  actorInstruction: string;
  privateReason: string | null;
  cause: CommandCause;
  payload: unknown;
  relatedEventId: string | null;
  status: ActorCommandStatus;
  runAfter: number;
  expiresAt: number | null;
  idempotencyKey: string;
  claimedBy: string | null;
  claimedAt: number | null;
  claimExpiresAt: number | null;
  resultEventId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorldDecisionLogValidationStatus = "accepted" | "rejected" | "model_failed" | "transaction_failed";

export interface WorldDecisionLogRecord {
  id: string;
  decisionId: string;
  worldRunId: string;
  userId: string;
  worldId: string;
  sourceType: string;
  sourceEventId: string | null;
  sourceTaskId: string | null;
  modelProvider: string;
  modelName: string;
  promptContextHash: string;
  rawDecisionJson: string | null;
  validatedDecisionJson: string | null;
  validationStatus: WorldDecisionLogValidationStatus;
  validationErrorsJson: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdEventIdsJson: string[];
  createdCommandIdsJson: string[];
  createdAt: number;
}

export type CreateWorldDecisionLogInput = Omit<WorldDecisionLogRecord, "id" | "createdAt">;

export type WorldMemoryVisibility = "public" | "private" | "hidden";

export interface WorldMemoryRecord {
  id: string;
  userId: string;
  worldId: string;
  subjectType: string;
  subjectKey: string;
  memoryType: string;
  canonicalKey: string | null;
  content: string;
  visibility: WorldMemoryVisibility;
  visibleToActorIds: string[];
  visibleToUser: boolean;
  importance: number;
  confidence: number;
  validFromTick: number;
  sourceEventId: string | null;
  sourceDecisionId: string | null;
  supersededBy: string | null;
  embeddingJson: string | null;
  embeddingQuality: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CreateWorldMemoryInput = Omit<WorldMemoryRecord, "id" | "createdAt" | "updatedAt">;

export interface VisibleActorDirective {
  commandId: string;
  actorInstruction: string;
  relatedEventSummary?: string;
}
