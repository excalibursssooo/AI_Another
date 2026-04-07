from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class AgentProfile:
    id: str
    name: str
    persona: str
    background: str
    display_name: str = ""
    hobbies: list[str] = field(default_factory=list)
    speaking_style: str = "warm"
    status: str = "active"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_persona_prompt(self) -> str:
        hobbies_text = "、".join(self.hobbies) if self.hobbies else "无特别偏好"
        shown_name = self.display_name or self.name
        return (
            f"你当前扮演的真实角色名为{self.name}，你正在和用户聊天。"
            f"你在用户那里的备注名是：{shown_name}。"
            "请保持角色一致性，不要跳出角色设定。"
        )
