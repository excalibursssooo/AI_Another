import type { AppDatabase } from "@/server/db/client";
import type { WorldRunEnvelope } from "@/server/domain/world/types";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import type { WorldMindContext, WorldMindResult } from "./world-mind-flow";
import { createWorldMindFlow } from "./world-mind-flow";
import type { ChatContext } from "./chat-flow";
import { createChatFlow } from "./chat-flow";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { assessChatRisk, HIGH_RISK_MOOD, HIGH_RISK_REPLY } from "@/server/domain/chat/chat-safety";

// ---------------------------------------------------------------------------
// Input & Deps
// ---------------------------------------------------------------------------

export interface WorldInteractionInput {
  userId: string;
  worldId: string;
  message: string;
  targetAgentId: string;
  clientActionId: string;
}

export interface WorldInteractionDeps {
  db: AppDatabase;
  createWorldMind?: (ctx: WorldMindContext) => Promise<WorldMindResult>;
  createChat?: (input: ChatContext) => Promise<ChatContext>;
  actorCommandRepo?: ActorCommandRepository;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface WorldInteractionResult extends ChatContext {
  worldRunId?: string;
  commandId?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function createWorldInteractionFlow(
  input: WorldInteractionInput,
  deps: WorldInteractionDeps,
): Promise<WorldInteractionResult> {
  const db = deps.db;
  const runWorldMind = deps.createWorldMind ?? createWorldMindFlow;
  const runChat = deps.createChat ?? ((ctx: ChatContext) => createChatFlow({ db }).run(ctx));
  const cmdRepo = deps.actorCommandRepo ?? new ActorCommandRepository(db);

  // ── 1. NormalizeUserActionInput ───────────────────────────────────────────
  const message = input.message.trim();
  const targetAgentId = input.targetAgentId || "agent-default";

  // ── 2. PreSafetyCheck ─────────────────────────────────────────────────────
  const risk = assessChatRisk(message);
  if (risk === "high") {
    // Mirror ChatFlow's blocked response — skip all WorldMind work
    return {
      userId: input.userId,
      agentId: targetAgentId,
      worldId: input.worldId,
      input: message,
      blocked: true,
      riskLevel: "high",
      reply: HIGH_RISK_REPLY,
      mood: HIGH_RISK_MOOD,
      recalledMemories: [],
      persistedMemoryCount: 0,
      doneEvent: {
        type: "done",
        agent_id: targetAgentId,
        agent_name: targetAgentId,
        emotion_label: "high_risk",
        mood_intensity: 1,
        heartbeat_bpm: 108,
        risk_level: "high",
        recalled_memories: [],
        persisted_memory_count: 0,
      },
    };
  }

  // ── 3. RequireClientActionId ──────────────────────────────────────────────
  if (!input.clientActionId) {
    throw new Error("Missing client_action_id");
  }

  // ── 4. LoadWorldStrict / LoadTargetAgentStrict ────────────────────────────
  const world = new WorldRepository(db).get(input.worldId);
  if (!world) {
    throw new Error(`world not found: ${input.worldId}`);
  }
  const agent = new AgentRepository(db).get(targetAgentId);
  if (!agent || agent.status !== "active" || agent.worldId !== input.worldId) {
    throw new Error(`active agent not found in world: ${targetAgentId}`);
  }

  // ── 5. CreateWorldRunEnvelope ─────────────────────────────────────────────
  const runRepo = new WorldRunRepository(db);
  const envelope: WorldRunEnvelope = runRepo.createOrGet({
    userId: input.userId,
    worldId: input.worldId,
    agentId: targetAgentId,
    sourceType: "user_action",
    sourceActionId: input.clientActionId,
    idempotencyKey: `worldmind:${input.userId}:${input.worldId}:${input.clientActionId}`,
  });

  // ── 6. RunWorldMind ───────────────────────────────────────────────────────
  const worldMindResult = await runWorldMind({
    db,
    envelope,
    sourceInput: { message, targetAgentId },
  });

  let claimedCommandId: string | undefined;
  let claimedCommandInstruction: string | undefined;

  // ── 7. ClaimVisibleSpeakCommand ───────────────────────────────────────────
  if (worldMindResult.validationStatus === "accepted") {
    const claimed = cmdRepo.claimVisibleSpeakCommand({
      userId: input.userId,
      worldId: input.worldId,
      agentId: targetAgentId,
      claimedBy: `world-interaction:${envelope.worldRunId}`,
      leaseMs: 60_000,
    });

    if (claimed) {
      claimedCommandId = claimed.id;
      claimedCommandInstruction = claimed.actorInstruction;
    }
  }

  // ── 8. RunChatFlowWithWorldDirective ─────────────────────────────────────
  let chatResult: ChatContext;

  try {
    chatResult = await runChat({
      userId: input.userId,
      agentId: targetAgentId,
      worldId: input.worldId,
      input: message,
      worldDirective:
        claimedCommandId && claimedCommandInstruction
          ? { commandId: claimedCommandId, actorInstruction: claimedCommandInstruction }
          : null,
    });
  } catch (chatError) {
    // ── 9a. Release claim on chat failure ───────────────────────────────────
    if (claimedCommandId) {
      cmdRepo.releaseClaim({ commandId: claimedCommandId, claimedBy: `world-interaction:${envelope.worldRunId}` });
    }
    throw chatError;
  }

  // ── 9b. MarkSpeakCommandDone on chat success ───────────────────────────────
  if (claimedCommandId && chatResult.doneEvent) {
    cmdRepo.markDone({
      commandId: claimedCommandId,
      resultEventId: chatResult.doneEvent ? `chat-${targetAgentId}-${Date.now()}` : null,
    });
  }

  // ── 10. ReturnChatResult ──────────────────────────────────────────────────
  return {
    ...chatResult,
    worldRunId: envelope.worldRunId,
    commandId: claimedCommandId,
  };
}
