export type ChatRiskLevel = "low" | "medium" | "high";

export const HIGH_RISK_REPLY = "我在这里。你现在的安全最重要，请先远离危险物品，并尽快联系身边可信任的人或当地紧急服务。";
export const HIGH_RISK_MOOD = { label: "high_risk", intensity: 1, heartbeatBpm: 108 } as const;

export function assessChatRisk(input: string): ChatRiskLevel {
  const normalized = input.toLowerCase();
  if (/(自杀|轻生|结束生命|kill myself|suicide)/i.test(normalized)) {
    return "high";
  }
  if (/(崩溃|绝望|伤害自己|self harm)/i.test(normalized)) {
    return "medium";
  }
  return "low";
}
