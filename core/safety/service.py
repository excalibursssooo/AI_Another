from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SafetyResult:
    level: str
    blocked: bool
    guidance: str | None


class SafetyService:
    """Simple risk gate for MVP."""

    HIGH_RISK_KEYWORDS = ["自杀", "不想活", "伤害自己", "伤害他人"]

    def check_risk(self, message: str) -> SafetyResult:
        if any(keyword in message for keyword in self.HIGH_RISK_KEYWORDS):
            return SafetyResult(
                level="high",
                blocked=True,
                guidance="你现在的安全最重要。请立刻联系当地紧急服务或可信任的人寻求帮助。如果你愿意，我也可以先陪你做一次呼吸稳定。",
            )
        return SafetyResult(level="low", blocked=False, guidance=None)
