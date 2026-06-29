import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import { CharacterStateRepository } from "@/server/domain/world/character-state-repository";
import { WorldEventRepository } from "@/server/domain/world/world-event-repository";
import { drainActorCommandTasks } from "./actor-command-worker";

function seedMoveCommand(db: ReturnType<typeof createTestDatabase>) {
  const [command] = new ActorCommandRepository(db).createMany([
    {
      decisionId: "wdec-1",
      worldRunId: "wrun-1",
      userId: "u001",
      worldId: "default",
      targetAgentId: "agent-default",
      commandType: "move_location",
      priority: "normal",
      visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
      actorInstruction: "Move to the harbor.",
      privateReason: "The harbor thread is active.",
      cause: { type: "director_no_event", reasonCode: "test" },
      payload: { locationKey: "harbor" },
      relatedEventId: null,
      runAfter: Date.now(),
      expiresAt: null,
      idempotencyKey: "cmd:move:1",
    },
  ]);
  return command;
}

describe("drainActorCommandTasks", () => {
  it("executes move_location by committing a character_action event before reducer state changes", async () => {
    const db = createTestDatabase();
    new CharacterStateRepository(db).getOrCreateDefault({ userId: "u001", worldId: "default", agentId: "agent-default" });
    const command = seedMoveCommand(db);

    const result = await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    expect(result).toEqual({ processed: 1, failed: 0 });
    const events = new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" });
    expect(events.map((event) => event.type)).toContain("character_action");
    expect(new CharacterStateRepository(db).listForWorld({ userId: "u001", worldId: "default" })[0].locationKey).toBe("harbor");
    expect(new ActorCommandRepository(db).getById(command.id)?.status).toBe("done");
    expect(new ActorCommandRepository(db).getById(command.id)?.resultEventId).toBeTruthy();
  });

  it("executes remember by creating a knowledge_reveal result event", async () => {
    const db = createTestDatabase();
    new ActorCommandRepository(db).createMany([
      {
        decisionId: "wdec-1",
        worldRunId: "wrun-1",
        userId: "u001",
        worldId: "default",
        targetAgentId: "agent-default",
        commandType: "remember",
        priority: "normal",
        visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
        actorInstruction: "Remember the harbor password clue.",
        privateReason: null,
        cause: { type: "director_no_event", reasonCode: "test" },
        payload: { canonicalKey: "secret:harbor-password", content: "The harbor password clue is a silver bell." },
        relatedEventId: null,
        runAfter: Date.now(),
        expiresAt: null,
        idempotencyKey: "cmd:remember:1",
      },
    ]);

    const result = await drainActorCommandTasks({ db, limit: 1, workerId: "actor-worker" });

    expect(result.processed).toBe(1);
    expect(new WorldEventRepository(db).listCommitted({ userId: "u001", worldId: "default" }).some((event) => event.type === "knowledge_reveal")).toBe(true);
  });
});
