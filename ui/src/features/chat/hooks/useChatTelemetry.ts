import { useEffect } from "react";

import { POLL_INTERVALS } from "@/config/constants";
import { reportFrontendError, reportWebVital, sendHeartbeat } from "@/lib/api/telemetry";
import type { FrontendErrorRequestDto, HeartbeatRequestDto, WebVitalRequestDto } from "@/lib/api/types_api";

interface UseChatTelemetryOptions {
  sessionId: string;
  mode: string;
  userId: string;
}

interface HeartbeatPayloadInput {
  sessionId: string;
  mode: string;
  page: string;
  userId: string;
}

interface ErrorPayloadInput {
  event: Pick<ErrorEvent, "message" | "filename" | "error">;
  page: string;
  userId: string;
}

interface RejectionPayloadInput {
  reason: unknown;
  page: string;
  userId: string;
}

interface PageLoadPayloadInput {
  value: number;
  page: string;
  sessionId: string;
}

export function createHeartbeatPayload(input: HeartbeatPayloadInput): HeartbeatRequestDto {
  return {
    session_id: input.sessionId,
    page: input.page,
    mode: input.mode,
    user_id: input.userId,
  };
}

export function createErrorPayload(input: ErrorPayloadInput): FrontendErrorRequestDto {
  return {
    message: input.event.message || "unknown window error",
    page: input.page,
    source: input.event.filename || "window.onerror",
    stack: input.event.error instanceof Error ? input.event.error.stack : undefined,
    user_id: input.userId,
  };
}

export function createUnhandledRejectionPayload(input: RejectionPayloadInput): FrontendErrorRequestDto {
  let message = "unhandled rejection";
  let stack: string | undefined;

  if (input.reason instanceof Error) {
    message = input.reason.message;
    stack = input.reason.stack;
  } else if (typeof input.reason === "string") {
    message = input.reason;
  } else {
    message = JSON.stringify(input.reason);
  }

  return {
    message,
    page: input.page,
    source: "unhandledrejection",
    stack,
    user_id: input.userId,
  };
}

export function createPageLoadPayload(input: PageLoadPayloadInput): WebVitalRequestDto {
  return {
    name: "page_load_ms",
    value: input.value,
    page: input.page,
    metric_id: input.sessionId,
    rating: input.value > 3_000 ? "poor" : input.value > 1_500 ? "needs-improvement" : "good",
  };
}

export function useChatTelemetry(options: UseChatTelemetryOptions): void {
  const { sessionId, mode, userId } = options;

  useEffect(() => {
    const page = window.location.pathname;
    const send = () => void sendHeartbeat(createHeartbeatPayload({ sessionId, mode, userId, page }));

    send();
    const heartbeatTimer = setInterval(send, POLL_INTERVALS.HEARTBEAT_TELEMETRY);
    return () => clearInterval(heartbeatTimer);
  }, [mode, sessionId, userId]);

  useEffect(() => {
    const page = window.location.pathname;
    const onError = (event: ErrorEvent) => {
      void reportFrontendError(createErrorPayload({ event, page, userId }));
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      void reportFrontendError(createUnhandledRejectionPayload({ reason: event.reason, page, userId }));
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [userId]);

  useEffect(() => {
    const page = window.location.pathname;
    const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const value = navEntry ? navEntry.loadEventEnd - navEntry.startTime : performance.now();

    void reportWebVital(createPageLoadPayload({ value, page, sessionId }));
  }, [sessionId]);
}
