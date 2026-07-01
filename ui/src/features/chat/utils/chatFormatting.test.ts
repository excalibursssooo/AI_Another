import { afterEach, describe, expect, it, vi } from "vitest";

import { formatAgo, formatTimeFromIso, nowTime, uid } from "./chatFormatting";

describe("chat formatting utilities", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("formats the current local time as HH:mm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 1, 3, 4, 0));

    expect(nowTime()).toBe("03:04");
  });

  it("formats an ISO timestamp or falls back to the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 1, 9, 8, 0));

    expect(formatTimeFromIso("2026-07-01T05:07:00")).toBe("05:07");
    expect(formatTimeFromIso("not-a-date")).toBe("09:08");
  });

  it("formats relative age labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));

    expect(formatAgo("not-a-date")).toBe("刚刚");
    expect(formatAgo("2026-07-01T11:59:15.000Z")).toBe("45秒前");
    expect(formatAgo("2026-07-01T11:55:00.000Z")).toBe("5分钟前");
    expect(formatAgo("2026-07-01T09:00:00.000Z")).toBe("3小时前");
    expect(formatAgo("2026-07-01T12:00:10.000Z")).toBe("0秒前");
  });

  it("creates a timestamped id with a random suffix", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    expect(uid("msg")).toBe("msg-1234567890-4fzzz");
  });
});
