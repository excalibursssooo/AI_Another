import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository } from "@/server/domain/world/character-state-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldStateRepository, createInitialWorldSnapshot } from "@/server/domain/world/world-state-repository";
import { reduceWorldEvents } from "@/server/domain/world/world-reducer";
import type { ActorCommandRecord, WorldEventRecord } from "@/server/domain/world/types";

import { createFeedGenerateFlow } from "./feed-flow";

export interface DrainActorCommandTasksResult {
  processed: number;
  failed: number;
}

export async function drainActorCommandTasks(options: {
  db: AppDatabase;
  limit?: number;
  workerId?: string;
}): Promise<DrainActorCommandTasksResult> {
  const commands = new ActorCommandRepository(options.db);
  const workerId = options.workerId ?? "actor-command-worker";
  const limit = Math.max(0, options.limit ?? 3);
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const command = commands.claimNextExecutableCommand({ workerId, leaseMs: 60_000 });
    if (!command) {
      break;
    }

    try {
      const resultEvent = await executeActorCommand({ db: options.db, command });
      commands.markDoneByWorker({ commandId: command.id, claimedBy: workerId, resultEventId: resultEvent?.id ?? null });
      processed += 1;
    } catch (error) {
      commands.markFailed({ commandId: command.id, claimedBy: workerId, reason: error instanceof Error ? error.message : String(error) });
      failed += 1;
    }
  }

  return { processed, failed };
}

async function executeActorCommand(input: {
  db: AppDatabase;
  command: ActorCommandRecord;
}): Promise<WorldEventRecord | null> {
  if (input.command.commandType === "publish_post") {
    await createFeedGenerateFlow({ db: input.db }).run({
      userId: input.command.userId,
      agentId: input.command.targetAgentId,
      worldId: input.command.worldId,
      sourceTaskId: input.command.id,
    });
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "publish_post", summary: input.command.actorInstruction },
      summary: "Actor published a feed post.",
    });
  }

  if (input.command.commandType === "move_location") {
    const payload = input.command.payload as { locationKey?: unknown };
    if (typeof payload.locationKey !== "string" || payload.locationKey.length === 0) {
      throw new Error("move_location payload requires locationKey");
    }
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "move_location", locationKey: payload.locationKey, summary: input.command.actorInstruction },
      summary: input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "investigate") {
    return commitCommandResultEvent(input, {
      type: "character_action",
      payload: { action: "investigate", summary: input.command.actorInstruction },
      summary: input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "remember") {
    const payload = input.command.payload as { canonicalKey?: unknown; content?: unknown };
    const factKey = typeof payload.canonicalKey === "string" && payload.canonicalKey.length > 0 ? payload.canonicalKey : `memory:${input.command.id}`;
    return commitCommandResultEvent(input, {
      type: "knowledge_reveal",
      payload: { factKey, summary: typeof payload.content === "string" ? payload.content : input.command.actorInstruction },
      summary: typeof payload.content === "string" ? payload.content : input.command.actorInstruction,
    });
  }

  if (input.command.commandType === "initiate_event") {
    return commitCommandResultEvent(input, {
      type: "world_incident",
      payload: { title: "Actor initiated event", description: input.command.actorInstruction, unresolved: true },
      summary: input.command.actorInstruction,
    });
  }

  throw new Error(`Unsupported actor command type: ${input.command.commandType}`);
}

function commitCommandResultEvent(input: {
  db: AppDatabase;
  command: ActorCommandRecord;
}, eventInput: {
  type: Exclude<WorldEventRecord["type"], "user_action">;
  payload: unknown;
  summary: string;
}): WorldEventRecord {
  const eventRepo = new WorldEventRepository(input.db);
  const snapshotRepo = new WorldStateRepository(input.db);
  const charRepo = new CharacterStateRepository(input.db);

  return input.db.sqlite.transaction(() => {
    const sequence = eventRepo.allocateNextSequence({
      userId: input.command.userId,
      worldId: input.command.worldId,
    });
    const event = eventRepo.createCommitted({
      decisionId: input.command.decisionId,
      worldRunId: input.command.worldRunId,
      userId: input.command.userId,
      worldId: input.command.worldId,
      tick: 1,
      sequence,
      type: eventInput.type,
      payload: eventInput.payload,
      summary: eventInput.summary,
      visibility: input.command.visibility,
      actorIds: [input.command.targetAgentId],
      causedByEventId: input.command.relatedEventId,
      idempotencyKey: `${input.command.id}:result`,
    });

    const previousSnapshot =
      snapshotRepo.getLatest({ userId: input.command.userId, worldId: input.command.worldId }) ??
      createInitialWorldSnapshot({ userId: input.command.userId, worldId: input.command.worldId });
    const characterStates = charRepo.listForWorld({ userId: input.command.userId, worldId: input.command.worldId });
    const reducerResult = reduceWorldEvents({
      previousSnapshot,
      events: [event],
      reducerVersion: 1,
      previousCharacterStates: characterStates,
    });

    snapshotRepo.saveLatest({
      ...reducerResult.worldSnapshot,
      id: `wsnap-${randomUUID()}`,
      appliedEventIds: reducerResult.appliedEventIds,
      reducerVersion: 1,
      updatedAt: Date.now(),
    });
    if (reducerResult.characterStates && reducerResult.characterStates.length > 0) {
      charRepo.upsertMany(reducerResult.characterStates);
    }
    return event;
  })();
}
