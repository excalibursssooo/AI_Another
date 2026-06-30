import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { WorldRunRepository } from "@/server/domain/world/world-run-repository";
import { createWorldMindFlow } from "./world-mind-flow";
import { drainActorCommandTasks } from "./actor-command-worker";
import { drainWorldTickTasks } from "./world-tick-worker";

describe("WorldMind long-running loop", () => {
  it("runs accepted user action, scheduled tick, and actor command without duplicate events", async () => {
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

    await createWorldMindFlow({
      db,
      envelope,
      sourceInput: { message: "go inspect the harbor", targetAgentId: "agent-default" },
      generateDecision: async () => ({
        modelProvider: "test",
        modelName: "test-director",
        rawDecisionJson: "{}",
        decision: {
          observations: [],
          intent: "dispatch_commands",
          events: [
            {
              clientEventId: "evt-1",
              type: "world_incident",
              actorIds: ["agent-default"],
              payload: {
                title: "Harbor clue",
                description: "A light flickers at the harbor.",
                unresolved: true,
                factKey: "harbor-light",
              },
              visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
              summary: "A light flickers at the harbor.",
            },
          ],
          commands: [
            {
              commandType: "move_location",
              targetAgentId: "agent-default",
              priority: "normal",
              visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
              actorInstruction: "Move to the harbor.",
              privateReason: null,
              cause: { type: "proposed_event", clientEventId: "evt-1" },
              payload: { locationKey: "harbor" },
              relatedEventSummary: "A light flickers at the harbor.",
            },
          ],
          memories: [],
          nextTick: { delayMs: 30_000, reason: "follow harbor clue" },
        },
      }),
    });

    expect(db.sqlite.prepare("SELECT * FROM tasks WHERE kind = 'world_tick'").all()).toHaveLength(1);
    db.sqlite
      .prepare("UPDATE tasks SET run_after = ?, next_attempt_at = ?, status = 'pending', locked_by = NULL, locked_at = NULL, lock_expires_at = NULL WHERE kind = 'world_tick'")
      .run(Date.now() - 1, Date.now() - 1);

    await drainWorldTickTasks({
      db,
      limit: 1,
      workerId: "tick-worker",
      createWorldMind: async () => ({
        validationStatus: "accepted",
        decisionLogId: "tick-log",
        createdEventIds: [],
        createdCommandIds: [],
        proposedEventIdToCommittedEventId: {},
      }),
    });
    await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    const events = new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" });
    expect(events.map((event) => event.type)).toEqual(["user_action", "world_incident", "character_action"]);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
    expect(new ActorCommandRepository(db).claimNextExecutableCommand({ workerId: "actor-worker-2", leaseMs: 30_000 })).toBeNull();
  });
});
