import { describe, expect, it } from "vitest";
import {
  MemoryCandidateSubjectSchema,
  MemoryCandidateSchema,
  MemoryExtractionSchema,
} from "./schemas";

describe("MemoryCandidateSubjectSchema", () => {
  it("accepts only the 3 enums (user, agent, world)", () => {
    const result = MemoryCandidateSubjectSchema.safeParse("user");
    expect(result.success).toBe(true);
    expect(result.data).toBe("user");

    const result2 = MemoryCandidateSubjectSchema.safeParse("agent");
    expect(result2.success).toBe(true);
    expect(result2.data).toBe("agent");

    const result3 = MemoryCandidateSubjectSchema.safeParse("world");
    expect(result3.success).toBe(true);
    expect(result3.data).toBe("world");
  });

  it('rejects "unknown" subject', () => {
    const result = MemoryCandidateSubjectSchema.safeParse("unknown");
    expect(result.success).toBe(false);
  });
});

describe("MemoryCandidateSchema", () => {
  it("parses a valid candidate with all fields", () => {
    const validCandidate = {
      subject: "user",
      type: "profile",
      content: "用户喜欢雨天散步",
      importance: 0.8,
      confidence: 0.9,
    };
    const result = MemoryCandidateSchema.safeParse(validCandidate);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validCandidate);
    }
  });

  it("rejects importance:1.1 (out of range)", () => {
    const invalidCandidate = {
      subject: "user",
      type: "profile",
      content: "some content",
      importance: 1.1,
      confidence: 0.9,
    };
    const result = MemoryCandidateSchema.safeParse(invalidCandidate);
    expect(result.success).toBe(false);
  });
});

describe("MemoryCandidateSchema canonical fields", () => {
  it("accepts optional key and topic for memory consolidation", () => {
    const parsed = MemoryCandidateSchema.parse({
      subject: "user",
      type: "preference",
      key: "preference.reminder.evening",
      topic: "reminders",
      content: "用户不要晚上提醒。",
      importance: 0.8,
      confidence: 0.9,
    });

    expect(parsed.key).toBe("preference.reminder.evening");
    expect(parsed.topic).toBe("reminders");
  });

  it("still accepts legacy candidates without key or topic", () => {
    const parsed = MemoryCandidateSchema.parse({
      subject: "user",
      type: "profile",
      content: "用户使用 zsh。",
      importance: 0.6,
      confidence: 0.8,
    });

    expect(parsed.key).toBeUndefined();
    expect(parsed.topic).toBeUndefined();
  });
});

describe("MemoryExtractionSchema", () => {
  it("accepts up to 8 memories in array", () => {
    const memories = Array.from({ length: 8 }, (_, i) => ({
      subject: "user" as const,
      type: "profile" as const,
      content: `Memory ${i}`,
      importance: 0.5,
      confidence: 0.5,
    }));
    const extraction = { memories };
    const result = MemoryExtractionSchema.safeParse(extraction);
    expect(result.success).toBe(true);
  });

  it("rejects 9 memories (exceeds max of 8)", () => {
    const memories = Array.from({ length: 9 }, (_, i) => ({
      subject: "user" as const,
      type: "profile" as const,
      content: `Memory ${i}`,
      importance: 0.5,
      confidence: 0.5,
    }));
    const extraction = { memories };
    const result = MemoryExtractionSchema.safeParse(extraction);
    expect(result.success).toBe(false);
  });
});
