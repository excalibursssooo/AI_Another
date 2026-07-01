export const POLL_INTERVALS = {
  HEARTBEAT_TELEMETRY: 45_000,
  AGENT_LIVE_STATE: 4_000,
  FEED_POSTS: 12_000,
} as const;

export const POLL_LIMITS = {
  MAX_BACKOFF_MS: 60_000,
  MAX_FAIL_COUNT: 5,
} as const;

export const DEFAULT_VITALS = {
  HEARTBEAT: 72,
  STRESS: 0.2,
  MOOD: 35,
} as const;

export const DEMO_USER_ID = "u001";

export function resolveDemoUserId(value: string | undefined): string {
  const userId = value?.trim();
  return userId || DEMO_USER_ID;
}

export const ANIMATION_DELAYS = {
  BIOMETRIC_JITTER_MS: 900,
  CREATION_COMPLETE: 620,
  CREATION_FAIL: 900,
  CUSTOM_CREATION_MIN_WAIT: 1_400,
  AI_CREATION_MIN_WAIT: 1_900,
} as const;
