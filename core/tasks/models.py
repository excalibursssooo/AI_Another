from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class TaskDraft:
    title: str
    priority: str
    deadline: str | None
    subtasks: list[str] = field(default_factory=list)


@dataclass
class TaskItem:
    id: str
    user_id: str
    title: str
    status: str
    priority: str
    deadline: str | None
    subtasks: list[str]
    source_message: str
    created_at: datetime
