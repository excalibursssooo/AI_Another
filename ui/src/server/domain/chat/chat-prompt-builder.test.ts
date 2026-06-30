import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt, buildChatUserPrompt } from "./chat-prompt-builder";

describe("chat prompt builders", () => {
  it("builds role, world, and directive context into the system prompt", () => {
    const prompt = buildChatSystemPrompt({
      agent: {
        displayName: "林夏",
        name: "linxia",
        persona: "温和但直接",
        background: "咖啡店老板",
        speakingStyle: "短句",
      },
      world: { lore: "海边小镇" },
      worldDirective: { actorInstruction: "ask about the weather" },
    });

    expect(prompt).toContain("你正在扮演 林夏。");
    expect(prompt).toContain("角色性格: 温和但直接");
    expect(prompt).toContain("世界观: 海边小镇");
    expect(prompt).toContain("当前世界指令: ask about the weather");
  });

  it("builds recent history, recalled memories, and user input into the user prompt", () => {
    const prompt = buildChatUserPrompt({
      input: "你记得我喜欢什么吗？",
      agent: { displayName: "林夏" },
      recentMessages: [
        { role: "user", content: "我喜欢雨天散步" },
        { role: "assistant", content: "我记住了" },
      ],
      recalledMemories: [{ memoryType: "preference", content: "用户喜欢雨天散步" }],
    });

    expect(prompt).toContain("用户: 我喜欢雨天散步");
    expect(prompt).toContain("林夏: 我记住了");
    expect(prompt).toContain("- preference: 用户喜欢雨天散步");
    expect(prompt).toContain("用户当前输入: 你记得我喜欢什么吗？");
  });
});
