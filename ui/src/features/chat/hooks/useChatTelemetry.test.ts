import { describe, expect, it } from "vitest";

import {
  createErrorPayload,
  createHeartbeatPayload,
  createPageLoadPayload,
  createUnhandledRejectionPayload,
} from "./useChatTelemetry";

describe("chat telemetry payload helpers", () => {
  it("creates heartbeat payloads with session, mode, page, and user", () => {
    expect(
      createHeartbeatPayload({
        sessionId: "session-1",
        mode: "live",
        page: "/chat",
        userId: "u001",
      }),
    ).toEqual({
      session_id: "session-1",
      mode: "live",
      page: "/chat",
      user_id: "u001",
    });
  });

  it("creates window error payloads with fallback source and message", () => {
    expect(
      createErrorPayload({
        event: {
          message: "",
          filename: "",
          error: new Error("boom"),
        },
        page: "/chat",
        userId: "u001",
      }),
    ).toMatchObject({
      message: "unknown window error",
      page: "/chat",
      source: "window.onerror",
      user_id: "u001",
    });
  });

  it("creates unhandled rejection payloads from Error and non-Error reasons", () => {
    expect(
      createUnhandledRejectionPayload({
        reason: new Error("failed"),
        page: "/chat",
        userId: "u001",
      }),
    ).toMatchObject({
      message: "failed",
      source: "unhandledrejection",
    });

    expect(
      createUnhandledRejectionPayload({
        reason: { code: "bad" },
        page: "/chat",
        userId: "u001",
      }),
    ).toMatchObject({
      message: JSON.stringify({ code: "bad" }),
      source: "unhandledrejection",
    });
  });

  it("creates page load payloads with rating thresholds", () => {
    expect(createPageLoadPayload({ value: 1000, page: "/chat", sessionId: "s" }).rating).toBe("good");
    expect(createPageLoadPayload({ value: 2000, page: "/chat", sessionId: "s" }).rating).toBe("needs-improvement");
    expect(createPageLoadPayload({ value: 4000, page: "/chat", sessionId: "s" }).rating).toBe("poor");
  });
});
