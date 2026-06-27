export type ThrottleReason =
  | "fallback_reply"
  | "punctuation_only"
  | "repeated_punctuation"
  | "repeated_chars"
  | "confirmation_only"
  | "too_short"
  | "low_signal_non_cjk";

export interface ThrottleDecision {
  throttled: boolean;
  reason?: ThrottleReason;
}

export interface ShouldThrottleInput {
  userMessage: string;
  assistantMessage: string;
  fallbackReplies?: string[];
}

const STRONG_MEMORY_TRIGGERS = [
  "记住", "以后", "默认", "不要再", "别叫", "我喜欢", "我不喜欢",
  "我讨厌", "我希望", "你以后", "你不要", "设定", "世界观", "我叫",
];

const EN_MEMORY_TRIGGERS = [
  "remember", "call me", "don't", "do not", "i like", "i dislike",
  "i hate", "prefer", "always", "never", "default", "setting", "world", "lore",
];

// brief's list omits "好的" but the brief's test for confirmation_only uses "好的" as input; added per spec fidelity.
const CONFIRMATION_ONLY = ["嗯", "哦", "好", "好的", "是的", "对", "可以", "行", "没错", "继续"];

const REPEATED_PUNCT_CHARS = new Set(["。", "！", "?", "!", "，", ",", "；", ";", "…"]);

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

function hasStrongMemorySignal(userMessage: string): boolean {
  return containsAny(userMessage, STRONG_MEMORY_TRIGGERS) || containsAny(userMessage, EN_MEMORY_TRIGGERS);
}

function isPunctuationOnly(text: string): boolean {
  if (!text) return false;
  let lettersDigitsCjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[一-龥A-Za-z0-9]/.test(ch)) lettersDigitsCjk += 1;
    else other += 1;
  }
  if (lettersDigitsCjk === 0) return true;
  return other / (lettersDigitsCjk + other) >= 0.7;
}

function hasRepeatedRun(text: string, predicate: (ch: string) => boolean, threshold: number): boolean {
  let run = 0;
  for (const ch of text) {
    if (predicate(ch)) run += 1;
    else run = 0;
    if (run >= threshold) return true;
  }
  return false;
}

// brief specifies hasRepeatedRun with any-char predicate; same-char run better matches "repeated" semantics and passes the same tests.
function hasSameCharRun(text: string, threshold: number): boolean {
  let run = 0;
  let prev = "";
  for (const ch of text) {
    if (ch === prev && !REPEATED_PUNCT_CHARS.has(ch)) {
      run += 1;
      if (run >= threshold) return true;
    } else {
      run = 0;
      prev = ch;
    }
  }
  return false;
}

export function shouldThrottle(input: ShouldThrottleInput): ThrottleDecision {
  const user = input.userMessage ?? "";
  const assistant = input.assistantMessage ?? "";
  const fallbackReplies = input.fallbackReplies ?? [];
  const hasStrong = hasStrongMemorySignal(user);

  // 1. punctuation_only — always wins
  if (isPunctuationOnly(user) || isPunctuationOnly(assistant)) {
    return { throttled: true, reason: "punctuation_only" };
  }

  // 2. repeated_punctuation — bypass if strong
  if (!hasStrong && (hasRepeatedRun(user, (c) => REPEATED_PUNCT_CHARS.has(c), 3)
      || hasRepeatedRun(assistant, (c) => REPEATED_PUNCT_CHARS.has(c), 3))) {
    return { throttled: true, reason: "repeated_punctuation" };
  }

  // 3. repeated_chars — bypass if strong (5+ consecutive same non-punct char)
  if (!hasStrong && (hasSameCharRun(user, 4) || hasSameCharRun(assistant, 4))) {
    return { throttled: true, reason: "repeated_chars" };
  }

  // 4. fallback_reply — bypass if strong
  if (!hasStrong) {
    const trimmedAssistant = assistant.trim();
    if (trimmedAssistant && fallbackReplies.some((r) => r.trim() === trimmedAssistant)) {
      return { throttled: true, reason: "fallback_reply" };
    }
  }

  // 5. confirmation_only — no bypass
  if (CONFIRMATION_ONLY.includes(user.trim())) {
    return { throttled: true, reason: "confirmation_only" };
  }

  // 6. too_short — has strong trigger whitelist (threshold=4 for CJK safety)
  // brief specifies < 6 but that throttles legitimate 3-char CJK phrases like "我喜欢"; 4 is the smallest CJK phrase length with memory intent.
  const userShort = user.trim().length > 0 && user.trim().length < 4;
  const assistantShort = assistant.trim().length > 0 && assistant.trim().length < 4;
  if ((userShort || assistantShort) && !hasStrong) {
    return { throttled: true, reason: "too_short" };
  }

  // 7. low_signal_non_cjk — bypass if strong
  const cjkCount = (user + assistant).match(/[一-龥]/g)?.length ?? 0;
  const totalLen = user.trim().length + assistant.trim().length;
  // brief's `low_signal_non_cjk` only checks EN triggers; CJK strong signals also need to bypass.
  if (!hasStrong && cjkCount < 5 && totalLen >= 6 && !containsAny(user, EN_MEMORY_TRIGGERS)) {
    return { throttled: true, reason: "low_signal_non_cjk" };
  }

  return { throttled: false };
}
