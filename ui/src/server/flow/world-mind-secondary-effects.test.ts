import { describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { WorldMemoryRepository } from "@/server/domain/world/world-memory-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import type { WorldMindDecision } from "@/server/domain/world/world-decision";
import { createWorldMindFlow } from "./world-mind-flow";

function decisionWithMemoryAndTick(): WorldMindDecision {
  return {
    observations: ["A thread remains unresolved."],
    intent: "trigger_event",
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: [],
        payload: {
          title: "A lock goes missing",
          description: "The gate lock is missing.",
          unresolved: true,
          factKey: "gate-lock-missing",
        },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "The gate lock is missing.",
      },
    ],
    commands: [],
    memories: [
      {
        subjectType: "world",
        subjectKey: "default",
        memoryType: "unresolved_thread",
        canonicalKey: "thread:gate-lock",
        content: "The missing lock needs follow-up.",
        visibility: { mode: "hidden", visibleToActorIds: [], visibleToUser: false },
        importance: 0.8,
        confidence: 0.9,
        sourceEventId: "CLIENT_EVENT:evt-1",
      },
    ],
    nextTick: { delayMs: 60_000, reason: "follow up on missing lock" },
  };
}

describe("WorldMind secondary effects", () => {
  it("consolidates memory candidates and schedules one idempotent next tick after accepted commit", async () => {
    const db = createTestDatabase();
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const envelope = new WorldRunRepository(db).createOrGet({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      sourceType: "user_action",
      sourceActionId: "client-1",
      idempotencyKey: "worldmind:u001:default:client-1",
    });
    const decision = decisionWithMemoryAndTick();

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "inspect the gate", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
      embedText: async () => ({
        vector: [1, 0],
        dimension: 2,
        backend: "fallback",
        quality: "lexical",
        model: "test",
        version: 1,
        needsRefresh: true,
      }),
    });

    expect(new WorldMemoryRepository(db).recallForDirector({ userId: "u001", worldId: "default", subjectType: "world" })).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT * FROM tasks WHERE kind = 'world_tick'").all()).toHaveLength(1);

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "inspect the gate", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        decision,
        rawDecisionJson: JSON.stringify(decision),
        modelProvider: "test",
        modelName: "test-director",
      }),
    }).catch(() => null);

    expect(db.sqlite.prepare("SELECT * FROM tasks WHERE kind = 'world_tick'").all()).toHaveLength(1);
  });

  it("does not schedule endless ticks for accepted no-op decisions without unresolved state", async () => {
    const db = createTestDatabase();
    const enqueueSpy = vi.spyOn(TaskRepository.prototype, "enqueue");
    new WorldRepository(db).upsert({ id: "default", name: "World", lore: "", tone: "", constraints: [], seedMemories: [] });
    const envelope = new WorldRunRepository(db).createOrGet({
      userId: "u001",
      worldId: "default",
      sourceType: "scheduled_tick",
      sourceActionId: "task-1",
      idempotencyKey: "worldtick:task-1",
    });

    await createWorldMindFlow({
      db,
      envelope,
      generateDecision: async () => ({
        decision: { observations: [], intent: "no_op", events: [], commands: [], memories: [], nextTick: null },
        rawDecisionJson: "{}",
        modelProvider: "test",
        modelName: "test-director",
      }),
    });

    expect(enqueueSpy).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "world_tick" }));
  });
});
