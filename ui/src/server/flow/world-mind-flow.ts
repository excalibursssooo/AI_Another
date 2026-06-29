import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { WorldRunEnvelope } from "@/server/domain/world/types";
import type { WorldMindDecision } from "@/server/domain/world/world-decision";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import type { CreateActorCommandInput } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository, createDefaultCharacterState } from "@/server/domain/world/character-state-repository";
import { AgentRepository, WorldRepository } from "@/server/domain/chat/repositories";
import { buildWorldDirectorContext } from "@/server/domain/world/world-context-builder";
import { WorldDecisionLogRepository } from "@/server/domain/world/world-decision-log-repository";
import { validateWorldMindDecision } from "@/server/domain/world/world-decision-validator";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { WorldStateRepository, createInitialWorldSnapshot } from "@/server/domain/world/world-state-repository";
import { reduceWorldEvents } from "@/server/domain/world/world-reducer";
import type { CharacterStateRecord, VisibilityScope, WorldEventRecord } from "@/server/domain/world/types";
import type { GenerateWorldDecision } from "@/server/ai/world-director";
import { generateWorldDecision } from "@/server/ai/world-director";

// ---------------------------------------------------------------------------
// Context & Result types
// ---------------------------------------------------------------------------

export interface WorldMindContext {
  db: AppDatabase;
  envelope: WorldRunEnvelope;
  sourceInput?: { message: string; targetAgentId: string };
  generateDecision?: GenerateWorldDecision;
  /** Pre-supplied decision — skips generation if provided. */
  decision?: WorldMindDecision;
}

export interface WorldMindResult {
  validationStatus: "accepted" | "rejected" | "model_failed" | "transaction_failed";
  decisionLogId: string;
  createdEventIds: string[];
  createdCommandIds: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function createWorldMindFlow(
  ctx: WorldMindContext,
): Promise<WorldMindResult> {
  const { db, envelope } = ctx;
  const userId = envelope.userId;
  const worldId = envelope.worldId;

  // ── 1. LoadWorldRunEnvelope ──────────────────────────────────────────────
  if (!ctx.envelope) {
    throw new Error("WorldRunEnvelope is required");
  }

  // ── 2. LoadWorldRuntime ───────────────────────────────────────────────────
  const worldRepo = new WorldRepository(db);
  const world = worldRepo.get(worldId);
  if (!world) {
    throw new Error(`World not found: ${worldId}`);
  }

  // ── 3. LoadWorldStateSnapshot ─────────────────────────────────────────────
  new WorldStateRepository(db).getLatest({ userId, worldId });

  // ── 4. LoadActiveActors ───────────────────────────────────────────────────
  const characterStates = loadActiveCharacterStates({ db, userId, worldId });
  const activeAgentIds = characterStates.map((c) => c.agentId);

  // ── 5. BuildDirectorContext ───────────────────────────────────────────────
  const dirContext = buildWorldDirectorContext({
    userId,
    worldId,
    sourceInput: ctx.sourceInput,
    targetAgentId: ctx.sourceInput?.targetAgentId,
    db,
  });

  // ── 6. GenerateDirectorDecision ─────────────────────────────────────────
  let decision: WorldMindDecision;
  let rawDecisionJson: string | null = null;
  let modelProvider = "mock";
  let modelName = "mock";
  let validationStatus: WorldMindResult["validationStatus"] = "accepted";

  if (ctx.decision) {
    decision = ctx.decision;
    rawDecisionJson = JSON.stringify(ctx.decision);
  } else {
    try {
      const generator = ctx.generateDecision ?? generateWorldDecision;
      const generated = await generator({ system: dirContext.system, prompt: dirContext.prompt });
      decision = generated.decision;
      rawDecisionJson = generated.rawDecisionJson;
      modelProvider = generated.modelProvider;
      modelName = generated.modelName;
    } catch (err) {
      return commitFailedPath({
        db,
        envelope,
        validationStatus: "model_failed",
        dirContext,
        ctx,
        characterStates,
        modelProvider,
        modelName,
        rawDecisionJson: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // ── 7. ValidateDirectorDecision ──────────────────────────────────────────
  const validation = validateWorldMindDecision({
    decision,
    activeAgentIds,
    hiddenFactSummaries: dirContext.hiddenFactSummaries,
    sourceType: envelope.sourceType,
  });

  if (!validation.ok) {
    validationStatus = "rejected";
    return commitFailedPath({
      db,
      envelope,
      validationStatus: "rejected",
      dirContext,
      ctx,
      characterStates,
      validationErrors: validation.errors,
      rawDecisionJson: rawDecisionJson ?? null,
      modelProvider,
      modelName,
    });
  }

  // ── 8. CommitWorldRunTransaction (accepted path) ─────────────────────────
  try {
    return await commitAcceptedPath({ db, envelope, decision, dirContext, ctx, characterStates, modelProvider, modelName, rawDecisionJson });
  } catch (err) {
    // Transaction failed — route to the transaction_failed path
    return commitFailedPath({
      db,
      envelope,
      validationStatus: "transaction_failed",
      dirContext,
      ctx,
      characterStates,
      error: err instanceof Error ? err : new Error(String(err)),
      rawDecisionJson: rawDecisionJson ?? null,
      modelProvider,
      modelName,
    });
  }
}

// ---------------------------------------------------------------------------
// Accepted path — all writes inside one atomic transaction
// ---------------------------------------------------------------------------

interface AcceptedPathInput {
  db: AppDatabase;
  envelope: WorldRunEnvelope;
  decision: WorldMindDecision;
  dirContext: ReturnType<typeof buildWorldDirectorContext>;
  ctx: WorldMindContext;
  characterStates: CharacterStateRecord[];
  modelProvider: string;
  modelName: string;
  rawDecisionJson: string | null;
}

async function commitAcceptedPath(input: AcceptedPathInput): Promise<WorldMindResult> {
  const { db, envelope, decision, dirContext, ctx, characterStates, modelProvider, modelName, rawDecisionJson } = input;
  const userId = envelope.userId;
  const worldId = envelope.worldId;

  const eventRepo = new WorldEventRepository(db);
  const snapshotRepo = new WorldStateRepository(db);
  const charRepo = new CharacterStateRepository(db);
  const cmdRepo = new ActorCommandRepository(db);
  const logRepo = new WorldDecisionLogRepository(db);
  const runRepo = new WorldRunRepository(db);

  // Allocate sequence number for the user_action event
  const userActionSequence = eventRepo.allocateNextSequence({ userId, worldId });

  // Idempotency key for the user_action event
  const userActionIdempotencyKey = `${envelope.worldRunId}:source:${envelope.sourceActionId}`;

  const result = db.sqlite.transaction(() => {
    // ── Insert user_action event ──────────────────────────────────────────
    const userActionEvent = eventRepo.createCommitted({
      decisionId: envelope.decisionId,
      worldRunId: envelope.worldRunId,
      userId,
      worldId,
      tick: 1,
      sequence: userActionSequence,
      type: "user_action",
      payload: {
        clientActionId: envelope.sourceActionId,
        normalizedMessage: ctx.sourceInput?.message ?? "",
        targetAgentId: ctx.sourceInput?.targetAgentId ?? "",
        interpretationStatus: "accepted",
      },
      summary: ctx.sourceInput?.message ?? "user action",
      visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
      actorIds: ctx.sourceInput?.targetAgentId ? [ctx.sourceInput.targetAgentId] : [],
      idempotencyKey: userActionIdempotencyKey,
    });

    // ── Insert derived events ──────────────────────────────────────────────
    const createdEventIds: string[] = [userActionEvent.id];

    for (const proposed of decision.events) {
      const eventSequence = eventRepo.allocateNextSequence({ userId, worldId });
      const eventIdempotencyKey = `${envelope.worldRunId}:${proposed.clientEventId}`;
      const ev = eventRepo.createCommitted({
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId,
        worldId,
        tick: 1,
        sequence: eventSequence,
        type: proposed.type as WorldEventRecord["type"],
        payload: proposed.payload,
        summary: proposed.summary,
        visibility: normalizeVisibility(proposed.visibility),
        actorIds: proposed.actorIds,
        idempotencyKey: eventIdempotencyKey,
        causedByUserActionId: userActionEvent.id,
      });
      createdEventIds.push(ev.id);
    }

    // ── Compute new snapshot via reducer ───────────────────────────────────
    const allEvents = eventRepo.listCommitted({ userId, worldId });
    const previousSnapshot = snapshotRepo.getLatest({ userId, worldId }) ?? createInitialWorldSnapshot({ userId, worldId });
    const reducerResult = reduceWorldEvents({
      previousSnapshot,
      events: allEvents,
      reducerVersion: 1,
      previousCharacterStates: characterStates,
    });

    snapshotRepo.saveLatest({
      ...reducerResult.worldSnapshot,
      id: `wsnap-${randomUUID()}`,
      appliedEventSequence: reducerResult.worldSnapshot.appliedEventSequence,
      appliedEventIds: reducerResult.appliedEventIds,
      reducerVersion: 1,
      updatedAt: Date.now(),
    });

    // ── Upsert character states if reducer mutated them ───────────────────
    if (reducerResult.characterStates && reducerResult.characterStates.length > 0) {
      charRepo.upsertMany(reducerResult.characterStates);
    }

    // ── Insert actor commands ───────────────────────────────────────────────
    const now = Date.now();
    const createdCommandIds: string[] = [];

    const commandInputs: CreateActorCommandInput[] = decision.commands.map((cmd) => {
      // Derive a stable idempotency key from the command's identity fields.
      // If two proposed commands have the same targetAgentId + commandType +
      // clientEventId (for proposed_event cause), they will collide — this is
      // the lever for the transaction_failed test.
      const causeKey =
        cmd.cause.type === "proposed_event" ? cmd.cause.clientEventId : cmd.cause.type;
      const idempotencyKey = `${envelope.worldRunId}:cmd:${cmd.targetAgentId}:${cmd.commandType}:${causeKey}`;
      return {
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId,
        worldId,
        targetAgentId: cmd.targetAgentId,
        commandType: cmd.commandType as CreateActorCommandInput["commandType"],
        priority: cmd.priority as CreateActorCommandInput["priority"],
        visibility: normalizeVisibility(cmd.visibility),
        actorInstruction: cmd.actorInstruction,
        privateReason: cmd.privateReason,
        cause: cmd.cause,
        payload: cmd.payload ?? {},
        relatedEventId: null,
        runAfter: now,
        expiresAt: null,
        idempotencyKey,
      };
    });

    const insertedCommands = cmdRepo.createMany(commandInputs);
    for (const c of insertedCommands) {
      createdCommandIds.push(c.id);
    }

    // Phase 3 only logs director memory candidates. Consolidation and persistence
    // are Phase 4 work and must not affect the core transaction.

    // ── Insert decision log (accepted) ─────────────────────────────────────
    const logRecord = logRepo.insert({
      decisionId: envelope.decisionId,
      worldRunId: envelope.worldRunId,
      userId,
      worldId,
      sourceType: envelope.sourceType,
      sourceEventId: null,
      sourceTaskId: null,
      modelProvider,
      modelName,
      promptContextHash: dirContext.promptContextHash,
      rawDecisionJson,
      validatedDecisionJson: JSON.stringify(decision),
      validationStatus: "accepted",
      validationErrorsJson: [],
      errorCode: null,
      errorMessage: null,
      createdEventIdsJson: createdEventIds,
      createdCommandIdsJson: createdCommandIds,
    });

    // ── Update run envelope to committed ─────────────────────────────────
    runRepo.markCommitted({ worldRunId: envelope.worldRunId });

    return {
      logId: logRecord.id,
      createdEventIds,
      createdCommandIds,
    };
  })();

  return {
    validationStatus: "accepted",
    decisionLogId: result.logId,
    createdEventIds: result.createdEventIds,
    createdCommandIds: result.createdCommandIds,
  };
}

// ---------------------------------------------------------------------------
// Failure paths — rejected / model_failed / transaction_failed
// ---------------------------------------------------------------------------

interface FailedPathInput {
  db: AppDatabase;
  envelope: WorldRunEnvelope;
  validationStatus: "rejected" | "model_failed" | "transaction_failed";
  dirContext: ReturnType<typeof buildWorldDirectorContext>;
  ctx: WorldMindContext;
  characterStates: CharacterStateRecord[];
  validationErrors?: string[];
  error?: Error | null;
  modelProvider?: string;
  modelName?: string;
  rawDecisionJson?: string | null;
}

async function commitFailedPath(input: FailedPathInput): Promise<WorldMindResult> {
  const { db, envelope, validationStatus, dirContext, ctx, characterStates, validationErrors, error, modelProvider = "mock", modelName = "mock", rawDecisionJson } = input;
  const userId = envelope.userId;
  const worldId = envelope.worldId;

  const eventRepo = new WorldEventRepository(db);
  const logRepo = new WorldDecisionLogRepository(db);
  const runRepo = new WorldRunRepository(db);

  // Allocate sequence for the observed_only user_action
  const sequence = eventRepo.allocateNextSequence({ userId, worldId });
  const idempotencyKey = `${envelope.worldRunId}:source:${envelope.sourceActionId}`;
  let decisionLogId = "";
  let createdEventIds: string[] = [];

  if (validationStatus !== "transaction_failed") {
    // rejected / model_failed — write observed_only user_action + decision log
    // inside a single transaction
    db.sqlite.transaction(() => {
      const sourceEvent = eventRepo.createCommitted({
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId,
        worldId,
        tick: 1,
        sequence,
        type: "user_action",
        payload: {
          clientActionId: envelope.sourceActionId,
          normalizedMessage: ctx.sourceInput?.message ?? "",
          targetAgentId: ctx.sourceInput?.targetAgentId ?? "",
          interpretationStatus: "observed_only",
          failureReason: validationStatus === "model_failed" ? "model_failed" : "validation_failed",
        },
        summary: ctx.sourceInput?.message ?? "user action",
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        actorIds: ctx.sourceInput?.targetAgentId ? [ctx.sourceInput.targetAgentId] : [],
        idempotencyKey,
      });

      const snapshotRepo = new WorldStateRepository(db);
      const charRepo = new CharacterStateRepository(db);
      const previousSnapshot = snapshotRepo.getLatest({ userId, worldId }) ?? createInitialWorldSnapshot({ userId, worldId });
      const reducerResult = reduceWorldEvents({
        previousSnapshot,
        events: [sourceEvent],
        reducerVersion: 1,
        previousCharacterStates: characterStates,
      });
      snapshotRepo.saveLatest({
        ...reducerResult.worldSnapshot,
        id: `wsnap-${randomUUID()}`,
        appliedEventSequence: reducerResult.worldSnapshot.appliedEventSequence,
        appliedEventIds: reducerResult.appliedEventIds,
        reducerVersion: 1,
        updatedAt: Date.now(),
      });
      if (reducerResult.characterStates && reducerResult.characterStates.length > 0) {
        charRepo.upsertMany(reducerResult.characterStates);
      }

      createdEventIds = [sourceEvent.id];

      const logRecord = logRepo.insert({
        decisionId: envelope.decisionId,
        worldRunId: envelope.worldRunId,
        userId,
        worldId,
        sourceType: envelope.sourceType,
        sourceEventId: sourceEvent.id,
        sourceTaskId: null,
        modelProvider,
        modelName,
        promptContextHash: dirContext.promptContextHash,
        rawDecisionJson: rawDecisionJson ?? null,
        validatedDecisionJson: null,
        validationStatus,
        validationErrorsJson: validationErrors ?? [],
        errorCode: validationStatus === "model_failed" ? "MODEL_ERROR" : "VALIDATION_ERROR",
        errorMessage:
          validationStatus === "model_failed"
            ? error?.message ?? "model generation failed"
            : validationErrors?.join("; ") ?? "validation failed",
        createdEventIdsJson: createdEventIds,
        createdCommandIdsJson: [],
      });
      decisionLogId = logRecord.id;

      if (validationStatus === "rejected") {
        runRepo.markRejected({ worldRunId: envelope.worldRunId });
      } else {
        runRepo.markFailed({ worldRunId: envelope.worldRunId });
      }
    })();
  } else {
    // transaction_failed — the main transaction already rolled back.
    // Write a best-effort decision log using a fresh (non-transactional) call.
    logRepo.insert({
      decisionId: envelope.decisionId,
      worldRunId: envelope.worldRunId,
      userId,
      worldId,
      sourceType: envelope.sourceType,
      sourceEventId: null,
      sourceTaskId: null,
      modelProvider,
      modelName,
      promptContextHash: dirContext.promptContextHash,
      rawDecisionJson: rawDecisionJson ?? null,
      validatedDecisionJson: null,
      validationStatus: "transaction_failed",
      validationErrorsJson: [error?.message ?? "transaction failed"],
      errorCode: "TRANSACTION_FAILED",
      errorMessage: error?.message ?? "transaction failed",
      createdEventIdsJson: [],
      createdCommandIdsJson: [],
    });

    runRepo.markFailed({ worldRunId: envelope.worldRunId });

    throw new Error(`transaction_failed: ${error?.message ?? "transaction failed"}`);
  }

  return {
    validationStatus,
    decisionLogId,
    createdEventIds,
    createdCommandIds: [],
  };
}

function normalizeVisibility(
  visibility: { mode: VisibilityScope["mode"]; visibleToActorIds: string[]; visibleToUser?: boolean },
): VisibilityScope {
  return {
    mode: visibility.mode,
    visibleToActorIds: visibility.visibleToActorIds,
    visibleToUser: visibility.mode === "public" ? true : visibility.visibleToUser ?? false,
  };
}

function loadActiveCharacterStates(input: { db: AppDatabase; userId: string; worldId: string }): CharacterStateRecord[] {
  const agents = new AgentRepository(input.db).listActive(input.worldId);
  const existingStates = new CharacterStateRepository(input.db).listForWorld({
    userId: input.userId,
    worldId: input.worldId,
  });
  const byAgentId = new Map(existingStates.map((state) => [state.agentId, state]));

  return agents.map(
    (agent) =>
      byAgentId.get(agent.id) ??
      createDefaultCharacterState({
        userId: input.userId,
        worldId: input.worldId,
        agentId: agent.id,
      }),
  );
}
