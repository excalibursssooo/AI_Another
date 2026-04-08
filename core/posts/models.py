from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class FeedPost:
    id: str
    user_id: str
    agent_id: str
    content: str
    topic_seed: str
    post_type: str
    status: str
    source_task_id: str | None
    created_at: datetime


@dataclass
class FeedPublishResult:
    post: FeedPost | None
    skipped: bool
    reason: str


@dataclass
class FeedListResult:
    items: list[FeedPost]
    total: int
    limit: int
    offset: int
