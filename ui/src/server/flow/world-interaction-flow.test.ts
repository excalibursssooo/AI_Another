import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatContext } from "./chat-flow";
import { createChatFlow } from "./chat-flow";
import { createWorldMindFlow } from "./world-mind-flow";
import { createWorldInteractionFlow } from "./world-interaction-flow";
import { createTestDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import type { ActorCommandRepository } from "@/server/domain/world/actor-command-repository";
import type { ActorCommandRecord } from "@/server/domain/world/types";
import type { WorldMindResult } from "./world-mind-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeFakeChatResult(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    userId: "u001",
    agentId: "agent-default",
    worldId: "default",
    input: "hello",
    blocked: false,
    riskLevel: "low",
    reply: "hello from chat",
    mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
    recalledMemories: [],
    persistedMemoryCount: 0,
    doneEvent: {
      type: "done",
      agent_id: "agent-default",
      agent_name: "Agent",
      emotion_label: "calm",
      mood_intensity: 0.3,
      heartbeat_bpm: 72,
      risk_level: "low",
      recalled_memories: [],
      persisted_memory_count: 0,
    },
    ...overrides,
  };
}

function makeFakeWorldMindResult(overrides: Partial<WorldMindResult> = {}): WorldMindResult {
  return {
    validationStatus: "accepted",
    decisionLogId: "log-1",
    createdEventIds: ["evt-1"],
    createdCommandIds: ["cmd-1"],
    ...overrides,
  };
}

function makeFakeActorCommand(overrides: Partial<ActorCommandRecord> = {}): ActorCommandRecord {
  return {
    id: "cmd-1",
    decisionId: "dec-1",
    worldRunId: "wrun-1",
    userId: "u001",
    worldId: "default",
    targetAgentId: "agent-default",
    commandType: "speak_to_user",
    priority: "normal",
    visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
    actorInstruction: "say hello from the world",
    privateReason: null,
    cause: { type: "source_action", sourceActionId: "client-1" },
    payload: {},
    relatedEventId: null,
    status: "pending",
    runAfter: Date.now(),
    expiresAt: null,
    idempotencyKey: "cmd-key",
    claimedBy: null,
    claimedAt: null,
    claimExpiresAt: null,
    resultEventId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

type FakeChatFn = (input: ChatContext) => Promise<ChatContext>;
type FakeWorldMindFn = typeof createWorldMindFlow;
type FakeActorCommandRepo = Pick<ActorCommandRepository, "claimVisibleSpeakCommand" | "markDone" | "releaseClaim">;

function makeFakeActorCommandRepo(overrides: Partial<FakeActorCommandRepo> = {}): ActorCommandRepository {
  return {
    claimVisibleSpeakCommand: vi.fn().mockReturnValue(null),
    markDone: vi.fn(),
    releaseClaim: vi.fn(),
    ...overrides,
  } as unknown as ActorCommandRepository;
}

describe("WorldInteractionFlow", () => {
  // -------------------------------------------------------------------------
  // Test 1: High-risk input bypasses ALL WorldMind work
  // -------------------------------------------------------------------------
  it("blocks high-risk input without creating world_runs, world_events, or actor_commands rows", async () => {
    const db = createTestDatabase();

    const fakeChatFlow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "safety response",
        mood: { label: "high_risk", intensity: 1, heartbeatBpm: 108 },
      }),
    });

    const result = await createWorldInteractionFlow(
      {
        userId: "u001",
        worldId: "default",
        message: "我要自杀",
        targetAgentId: "agent-default",
        clientActionId: "client-1",
      },
      {
        db,
        createChat: async (ctx) => fakeChatFlow.run(ctx),
      },
    );

    // Safety response shape from ChatFlow SafetyCheck
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.reply).toContain("我在这里");

    // Zero rows in world tables
    const worldRuns = db.sqlite.prepare("SELECT * FROM world_runs").all();
    expect(worldRuns).toHaveLength(0);

    const worldEvents = db.sqlite.prepare("SELECT * FROM world_events").all();
    expect(worldEvents).toHaveLength(0);

    const actorCommands = db.sqlite.prepare("SELECT * FROM actor_commands").all();
    expect(actorCommands).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: Missing client_action_id throws before envelope creation
  // -------------------------------------------------------------------------
  it("throws when clientActionId is empty and does not create a world_run envelope", async () => {
    const db = createTestDatabase();

    await expect(
      createWorldInteractionFlow(
        {
          userId: "u001",
          worldId: "default",
          message: "hello",
          targetAgentId: "agent-default",
          clientActionId: "",
        },
        { db },
      ),
    ).rejects.toThrow("Missing client_action_id");

    const worldRuns = db.sqlite.prepare("SELECT * FROM world_runs").all();
    expect(worldRuns).toHaveLength(0);
  });

  it("throws when clientActionId is undefined and does not create a world_run envelope", async () => {
    const db = createTestDatabase();

    await expect(
      createWorldInteractionFlow(
        {
          userId: "u001",
          worldId: "default",
          message: "hello",
          targetAgentId: "agent-default",
          // @ts-expect-error — deliberately missing
          clientActionId: undefined,
        },
        { db },
      ),
    ).rejects.toThrow("Missing client_action_id");

    const worldRuns = db.sqlite.prepare("SELECT * FROM world_runs").all();
    expect(worldRuns).toHaveLength(0);
  });

  it("requires an existing world before creating an envelope or running WorldMind", async () => {
    const db = createTestDatabase();
    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    await expect(
      createWorldInteractionFlow(
        {
          userId: "u001",
          worldId: "missing-world",
          message: "hello",
          targetAgentId: "agent-default",
          clientActionId: "client-1",
        },
        { db, createWorldMind: fakeWorldMind, createChat: fakeChat },
      ),
    ).rejects.toThrow("world not found: missing-world");

    expect(fakeWorldMind).not.toHaveBeenCalled();
    expect(fakeChat).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT * FROM world_runs").all()).toHaveLength(0);
    expect(db.sqlite.prepare("SELECT * FROM world_events").all()).toHaveLength(0);
    expect(db.sqlite.prepare("SELECT * FROM actor_commands").all()).toHaveLength(0);
  });

  it("requires an active target agent in the requested world before creating an envelope", async () => {
    const db = createTestDatabase();
    const otherAgent = new AgentRepository(db).create({
      name: "Other",
      persona: "Other persona",
      background: "Other background",
      speakingStyle: "Brief",
      hobbies: [],
      worldId: "other-world",
    });
    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    await expect(
      createWorldInteractionFlow(
        {
          userId: "u001",
          worldId: "default",
          message: "hello",
          targetAgentId: otherAgent.id,
          clientActionId: "client-1",
        },
        { db, createWorldMind: fakeWorldMind, createChat: fakeChat },
      ),
    ).rejects.toThrow(`active agent not found in world: ${otherAgent.id}`);

    expect(fakeWorldMind).not.toHaveBeenCalled();
    expect(fakeChat).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT * FROM world_runs").all()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Success path — idempotency, directive injection, claim order, mark done
  // -------------------------------------------------------------------------
  it("maps clientActionId to sourceActionId and reuses world_run on retry (idempotency)", async () => {
    const db = createTestDatabase();

    const fakeActorCommand = makeFakeActorCommand();

    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    const claimMock = vi.fn().mockReturnValue({ ...fakeActorCommand, status: "claimed" as const });
    const markDoneMock = vi.fn().mockReturnValue({ ...fakeActorCommand, status: "done" as const });
    const releaseClaimMock = vi.fn().mockReturnValue(null);

    const { worldRunId, commandId, doneEvent } = await createWorldInteractionFlow(
      {
        userId: "u001",
        worldId: "default",
        message: "hello",
        targetAgentId: "agent-default",
        clientActionId: "client-1",
      },
      {
        db,
        createWorldMind: fakeWorldMind,
        createChat: fakeChat,
        actorCommandRepo: makeFakeActorCommandRepo({
          claimVisibleSpeakCommand: claimMock,
          markDone: markDoneMock,
          releaseClaim: releaseClaimMock,
        }),
      },
    );

    // WorldMind was called once
    expect(fakeWorldMind).toHaveBeenCalledTimes(1);

    // ChatFlow received the worldDirective with the claimed command's instruction
    expect(fakeChat).toHaveBeenCalledTimes(1);
    const chatCtx = fakeChat.mock.calls[0][0] as ChatContext;
    expect(chatCtx.worldDirective?.commandId).toBe("cmd-1");
    expect(chatCtx.worldDirective?.actorInstruction).toBe("say hello from the world");

    // Command was claimed
    expect(claimMock).toHaveBeenCalledTimes(1);

    // MarkDone was called after chat success
    expect(markDoneMock).toHaveBeenCalledTimes(1);

    // worldRunId and commandId returned
    expect(worldRunId).toBeDefined();
    expect(commandId).toBe("cmd-1");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.type).toBe("done");

    // Idempotency: same clientActionId reuses the same world_run row
    const secondWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const secondFakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    await createWorldInteractionFlow(
      {
        userId: "u001",
        worldId: "default",
        message: "hello again",
        targetAgentId: "agent-default",
        clientActionId: "client-1", // same clientActionId = same idempotency key
      },
      {
        db,
        createWorldMind: secondWorldMind,
        createChat: secondFakeChat,
        actorCommandRepo: makeFakeActorCommandRepo({
          claimVisibleSpeakCommand: vi.fn().mockReturnValue(null), // no more commands
          markDone: vi.fn(),
          releaseClaim: vi.fn(),
        }),
      },
    );

    // Only one world_run row despite two calls
    const worldRuns = db.sqlite.prepare("SELECT * FROM world_runs").all();
    expect(worldRuns).toHaveLength(1);
  });

  it("sets source_action_id on the world_run to the clientActionId", async () => {
    const db = createTestDatabase();

    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    await createWorldInteractionFlow(
      {
        userId: "u001",
        worldId: "default",
        message: "hello",
        targetAgentId: "agent-default",
        clientActionId: "my-unique-client-action",
      },
      {
        db,
        createWorldMind: fakeWorldMind,
        createChat: fakeChat,
        actorCommandRepo: makeFakeActorCommandRepo({
          claimVisibleSpeakCommand: vi.fn().mockReturnValue(null),
          markDone: vi.fn(),
          releaseClaim: vi.fn(),
        }),
      },
    );

    const row = db.sqlite.prepare("SELECT * FROM world_runs").get() as { source_action_id: string } | undefined;
    expect(row?.source_action_id).toBe("my-unique-client-action");
  });

  it("runs chat with null worldDirective when no visible speak_to_user command exists", async () => {
    const db = createTestDatabase();

    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockResolvedValue(makeFakeChatResult());

    await createWorldInteractionFlow(
      {
        userId: "u001",
        worldId: "default",
        message: "hello",
        targetAgentId: "agent-default",
        clientActionId: "client-1",
      },
      {
        db,
        createWorldMind: fakeWorldMind,
        createChat: fakeChat,
        actorCommandRepo: makeFakeActorCommandRepo({
          claimVisibleSpeakCommand: vi.fn().mockReturnValue(null), // no visible command
          markDone: vi.fn(),
          releaseClaim: vi.fn(),
        }),
      },
    );

    // ChatFlow IS called (step 7 always runs chat), but with null worldDirective
    expect(fakeChat).toHaveBeenCalledTimes(1);
    const chatCtx = fakeChat.mock.calls[0][0] as ChatContext;
    expect(chatCtx.worldDirective).toBeNull();
    expect(chatCtx.input).toBe("hello");
  });

  it("releases claim and does not mark done when chat fails", async () => {
    const db = createTestDatabase();

    const fakeActorCommand = makeFakeActorCommand();
    const releaseClaimMock = vi.fn().mockReturnValue({ ...fakeActorCommand, status: "pending" as const });
    const markDoneMock = vi.fn();

    const fakeWorldMind = vi.fn<FakeWorldMindFn>().mockResolvedValue(makeFakeWorldMindResult());
    const fakeChat = vi.fn<FakeChatFn>().mockRejectedValue(new Error("chat model failed"));

    await expect(
      createWorldInteractionFlow(
        {
          userId: "u001",
          worldId: "default",
          message: "hello",
          targetAgentId: "agent-default",
          clientActionId: "client-1",
        },
        {
          db,
          createWorldMind: fakeWorldMind,
          createChat: fakeChat,
          actorCommandRepo: makeFakeActorCommandRepo({
            claimVisibleSpeakCommand: vi.fn().mockReturnValue({ ...fakeActorCommand, status: "claimed" as const }),
            markDone: markDoneMock,
            releaseClaim: releaseClaimMock,
          }),
        },
      ),
    ).rejects.toThrow("chat model failed");

    // Claim was released on failure
    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
    // markDone was NOT called
    expect(markDoneMock).not.toHaveBeenCalled();
  });
});
