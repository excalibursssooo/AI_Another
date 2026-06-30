import { describe, expect, it } from "vitest";

import { assessChatRisk } from "./chat-safety";

describe("assessChatRisk", () => {
  it("classifies high-risk self-harm language", () => {
    expect(assessChatRisk("我要自杀")).toBe("high");
    expect(assessChatRisk("I might kill myself")).toBe("high");
  });

  it("classifies medium-risk distress without emergency language", () => {
    expect(assessChatRisk("我快崩溃了")).toBe("medium");
  });

  it("classifies ordinary chat as low risk", () => {
    expect(assessChatRisk("今天想聊聊咖啡")).toBe("low");
  });
});
