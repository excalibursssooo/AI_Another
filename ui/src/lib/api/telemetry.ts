import { httpPost } from "@/lib/api/client";
import {
  FrontendErrorRequestDto,
  HeartbeatRequestDto,
  WebVitalRequestDto,
} from "@/lib/api/types";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "dev";

export async function sendHeartbeat(payload: HeartbeatRequestDto): Promise<void> {
  await httpPost<HeartbeatRequestDto, { status: string }>("/telemetry/heartbeat", {
    ...payload,
    app_version: payload.app_version || APP_VERSION,
  });
}

export async function reportFrontendError(payload: FrontendErrorRequestDto): Promise<void> {
  await httpPost<FrontendErrorRequestDto, { status: string }>("/telemetry/frontend-error", {
    ...payload,
    app_version: payload.app_version || APP_VERSION,
  });
}

export async function reportWebVital(payload: WebVitalRequestDto): Promise<void> {
  await httpPost<WebVitalRequestDto, { status: string }>("/telemetry/web-vitals", {
    ...payload,
    app_version: payload.app_version || APP_VERSION,
  });
}
