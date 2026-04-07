from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class MemoryItem:
    id: str
    user_id: str
    agent_id: str
    subject: str
    memory_type: str
    content: str
    confidence: float
    importance: float
    status: str
    created_at: datetime


@dataclass
class MemoryCandidate:
    subject: str
    memory_type: str
    content: str
    confidence: float
    importance: float
