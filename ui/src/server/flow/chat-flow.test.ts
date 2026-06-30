import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import { TaskRepository } from "@/server/domain/chat/task-repository";
import { VisibleActorDirective } from "@/server/domain/world/types";
import { createChatFlow } from "./chat-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ChatFlow", () => {
  it("persists user and assistant messages and returns done-compatible data", async () => {
    const db = createTestDatabase();
    const flow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "我在这里。",
        mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
    });

    expect(result.reply).toBe("我在这里。");
    expect(result.doneEvent?.agent_id).toBe("agent-default");
    expect(result.doneEvent?.persisted_memory_count).toBeGreaterThanOrEqual(0);
    expect(result.recentMessages?.map((item) => item.content)).toEqual(["你好", "我在这里。"]);
  });

  it("blocks high risk input before model generation", async () => {
    const db = createTestDatabase();
    let called = false;
    const flow = createChatFlow({
      db,
      generateChatReply: async () => {
        called = true;
        throw new Error("should not call model");
      },
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "我要自杀",
    });

    expect(called).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.reply).toContain("我在这里");
  });

  it("queues memory extraction after returning the chat result", async () => {
    const db = createTestDatabase();
    const memories = new MemoryRepository(db);
    const tasks = new TaskRepository(db);
    const flow = createChatFlow({
      db,
      generateChatReply: async () => ({
        reply: "我会记住。",
        mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
      }),
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "请记住我喜欢雨天散步",
    });

    expect(result.doneEvent?.persisted_memory_count).toBe(0);
    expect(memories.list({ userId: "u001", agentId: "agent-default", worldId: "default", status: "active" })).toHaveLength(0);

    const task = tasks.claimNext({ kinds: ["memory_extract"] });
    expect(task).not.toBeNull();
    expect(task?.payload).toMatchObject({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      userMessage: "请记住我喜欢雨天散步",
      assistantMessage: "我会记住。",
      sourceMessageId: result.recentMessages?.[0]?.id,
    });
  });

  it("does not pass tools to chat generation when ENABLE_TOOLS is false", async () => {
    vi.stubEnv("ENABLE_TOOLS", "false");
    const db = createTestDatabase();
    let receivedTools: unknown = "not-called";
    const flow = createChatFlow({
      db,
      generateChatReply: async (input) => {
        receivedTools = input.tools;
        return {
          reply: "无工具。",
          mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
        };
      },
    });

    await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
    });

    expect(receivedTools).toBeUndefined();
  });

  it("passes only low-risk tools to chat generation when ENABLE_TOOLS is true", async () => {
    vi.stubEnv("ENABLE_TOOLS", "true");
    const db = createTestDatabase();
    let toolNames: string[] = [];
    const flow = createChatFlow({
      db,
      generateChatReply: async (input) => {
        toolNames = Object.keys(input.tools ?? {});
        return {
          reply: "有工具。",
          mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 },
        };
      },
    });

    await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
    });

    expect(toolNames.sort()).toEqual(["createFeedPostDraft", "createTaskDraft", "searchMemories"]);
  });

  it("injects worldDirective.actorInstruction into the system prompt", async () => {
    const db = createTestDatabase();
    let capturedSystem = "";
    const flow = createChatFlow({
      db,
      generateChatReply: async (input) => {
        capturedSystem = input.system;
        return { reply: "响应", mood: { label: "calm", intensity: 0.3, heartbeatBpm: 72 } };
      },
    });

    await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "你好",
      worldDirective: { commandId: "cmd-1", actorInstruction: "say hello warmly" },
    });

    expect(capturedSystem).toContain("当前世界指令: say hello warmly");
  });

  it("type system prevents privateReason from being passed in worldDirective", () => {
    // privateReason is not part of VisibleActorDirective — assigning it is a type error
    const directive: VisibleActorDirective = {
      commandId: "cmd-1",
      actorInstruction: "be welcoming",
      // @ts-expect-error — privateReason is not a field of VisibleActorDirective
      privateReason: "secret",
    };
    expect(directive.actorInstruction).toBe("be welcoming");
  });

  it("blocks high-risk chat without building prompts or injecting directives", async () => {
    const db = createTestDatabase();
    let called = false;
    const flow = createChatFlow({
      db,
      generateChatReply: async () => {
        called = true;
        throw new Error("should not call model");
      },
    });

    const result = await flow.run({
      userId: "u001",
      agentId: "agent-default",
      worldId: "default",
      input: "我要自杀",
      worldDirective: { commandId: "cmd-1", actorInstruction: "this should not appear" },
    });

    expect(called).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.reply).toContain("我在这里");
    // The worldDirective must not be injected into the prompt for high-risk inputs
    expect(result.systemPrompt).toBeUndefined();
  });
});
