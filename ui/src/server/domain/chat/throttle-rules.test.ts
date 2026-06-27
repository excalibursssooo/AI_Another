import { describe, expect, it } from "vitest";
import { shouldThrottle, type ThrottleReason } from "./throttle-rules";

describe("shouldThrottle", () => {
  it("returns throttled=false for normal long input", () => {
    expect(shouldThrottle({
      userMessage: "我今天下午要去图书馆读一本关于向量数据库的书。",
      assistantMessage: "好的，我可以帮你推荐几本。",
    })).toEqual({ throttled: false });
  });

  it("throttles fallback_reply when user has no strong signal", () => {
    const decision = shouldThrottle({
      userMessage: "好的",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(decision).toEqual({ throttled: true, reason: "fallback_reply" });
  });

  it("does NOT throttle fallback_reply when user has strong memory signal", () => {
    const decision = shouldThrottle({
      userMessage: "以后叫我阿梁",
      assistantMessage: "当前模型暂时不可用，但我已经收到你的消息了。",
      fallbackReplies: ["当前模型暂时不可用，但我已经收到你的消息了。"],
    });
    expect(decision.throttled).toBe(false);
  });

  it("throttles punctuation_only regardless of strong signal", () => {
    expect(shouldThrottle({ userMessage: "!!!", assistantMessage: "" }))
      .toEqual({ throttled: true, reason: "punctuation_only" });
  });

  it("throttles repeated_punctuation when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "哈哈哈哈哈！！！", assistantMessage: "嗯" }))
      .toEqual({ throttled: true, reason: "repeated_punctuation" });
  });

  it("does NOT throttle repeated_punctuation when user has strong signal", () => {
    expect(shouldThrottle({ userMessage: "以后！！！", assistantMessage: "好" }).throttled).toBe(false);
  });

  it("throttles repeated_chars when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "啊啊啊啊啊", assistantMessage: "好" }))
      .toEqual({ throttled: true, reason: "repeated_chars" });
  });

  it("does NOT throttle repeated_chars when user has strong signal", () => {
    expect(shouldThrottle({ userMessage: "我叫梁梁梁梁梁", assistantMessage: "好" }).throttled).toBe(false);
  });

  it("throttles confirmation_only regardless of strong signal", () => {
    expect(shouldThrottle({ userMessage: "好的", assistantMessage: "好的" }))
      .toEqual({ throttled: true, reason: "confirmation_only" });
  });

  it("throttles too_short when no strong signal", () => {
    expect(shouldThrottle({ userMessage: "ab", assistantMessage: "cd" }))
      .toEqual({ throttled: true, reason: "too_short" });
  });

  it("does NOT throttle too_short when user has strong memory trigger", () => {
    expect(shouldThrottle({ userMessage: "我喜欢", assistantMessage: "好的" }).throttled).toBe(false);
  });

  it("throttles low_signal_non_cjk when no English trigger", () => {
    expect(shouldThrottle({ userMessage: "abc def ghi", assistantMessage: "ok sure thing" }))
      .toEqual({ throttled: true, reason: "low_signal_non_cjk" });
  });

  it("does NOT throttle low_signal_non_cjk when user has English memory trigger", () => {
    expect(shouldThrottle({ userMessage: "please call me V", assistantMessage: "ok" }).throttled).toBe(false);
  });

  it("handles missing optional fallbackReplies", () => {
    expect(() => shouldThrottle({ userMessage: "你好", assistantMessage: "你好" })).not.toThrow();
  });
});

const _r: ThrottleReason = "fallback_reply";
void _r;
