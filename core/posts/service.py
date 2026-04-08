from __future__ import annotations

from datetime import UTC, datetime
import json
import os
from pathlib import Path
from uuid import uuid4

from core.posts.models import FeedListResult, FeedPost, FeedPublishResult


class FeedService:
    """Stores and manages agent feed posts for each user."""

    def __init__(self, persist_path: Path | None = None) -> None:
        self._posts_by_user: dict[str, list[FeedPost]] = {}
        self._persist_path = persist_path
        self._load()

    @staticmethod
    def build_from_env() -> "FeedService":
        repository = _get_env("FEED_REPOSITORY", "json")
        if repository != "json":
            return FeedService()

        path_value = _get_env("FEED_JSON_PATH", "data/posts.json")
        return FeedService(persist_path=_resolve_project_path(path_value))

    def list_posts(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
        include_archived: bool = False,
    ) -> FeedListResult:
        bounded_limit = max(1, min(limit, 100))
        safe_offset = max(0, offset)

        rows = list(self._posts_by_user.get(user_id, []))
        if not include_archived:
            rows = [item for item in rows if item.status == "published"]

        rows.sort(key=lambda item: item.created_at, reverse=True)
        total = len(rows)
        sliced = rows[safe_offset : safe_offset + bounded_limit]
        return FeedListResult(
            items=sliced,
            total=total,
            limit=bounded_limit,
            offset=safe_offset,
        )

    def get_post(self, user_id: str, post_id: str) -> FeedPost | None:
        rows = self._posts_by_user.get(user_id, [])
        for item in rows:
            if item.id == post_id:
                return item
        return None

    def publish_post(
        self,
        *,
        user_id: str,
        agent_id: str,
        content: str,
        topic_seed: str,
        post_type: str = "status",
        source_task_id: str | None = None,
    ) -> FeedPublishResult:
        clean_content = content.strip()
        clean_topic = topic_seed.strip()
        if not clean_content:
            return FeedPublishResult(post=None, skipped=True, reason="empty_content")

        post = FeedPost(
            id=str(uuid4()),
            user_id=user_id,
            agent_id=agent_id,
            content=clean_content,
            topic_seed=clean_topic or clean_content,
            post_type=post_type.strip() or "status",
            status="published",
            source_task_id=source_task_id,
            created_at=datetime.now(UTC),
        )
        if user_id not in self._posts_by_user:
            self._posts_by_user[user_id] = []
        self._posts_by_user[user_id].append(post)
        self._save()
        return FeedPublishResult(post=post, skipped=False, reason="published")

    def archive_post(self, user_id: str, post_id: str) -> FeedPost | None:
        rows = self._posts_by_user.get(user_id, [])
        for index, item in enumerate(rows):
            if item.id != post_id:
                continue
            if item.status == "archived":
                return item
            rows[index] = FeedPost(
                id=item.id,
                user_id=item.user_id,
                agent_id=item.agent_id,
                content=item.content,
                topic_seed=item.topic_seed,
                post_type=item.post_type,
                status="archived",
                source_task_id=item.source_task_id,
                created_at=item.created_at,
            )
            self._save()
            return rows[index]
        return None

    def _load(self) -> None:
        if self._persist_path is None or not self._persist_path.exists():
            return

        with self._persist_path.open("r", encoding="utf-8") as file:
            raw = json.load(file)

        if not isinstance(raw, dict):
            return

        loaded: dict[str, list[FeedPost]] = {}
        for user_id, rows in raw.items():
            if not isinstance(user_id, str) or not isinstance(rows, list):
                continue

            posts: list[FeedPost] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                try:
                    content = str(row.get("content", "")).strip()
                    if not content:
                        continue
                    agent_id = str(row.get("agent_id", "")).strip() or "default"
                    posts.append(
                        FeedPost(
                            id=str(row.get("id", "")).strip() or str(uuid4()),
                            user_id=str(row.get("user_id", user_id)).strip() or user_id,
                            agent_id=agent_id,
                            content=content,
                            topic_seed=str(row.get("topic_seed", content)).strip() or content,
                            post_type=str(row.get("post_type", "status")).strip() or "status",
                            status=str(row.get("status", "published")).strip() or "published",
                            source_task_id=str(row.get("source_task_id", "")).strip() or None,
                            created_at=_parse_datetime(str(row.get("created_at", ""))),
                        ),
                    )
                except Exception:
                    continue

            loaded[user_id] = posts

        self._posts_by_user = loaded

    def _save(self) -> None:
        if self._persist_path is None:
            return

        self._persist_path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, list[dict[str, object]]] = {}
        for user_id, posts in self._posts_by_user.items():
            payload[user_id] = [
                {
                    "id": item.id,
                    "user_id": item.user_id,
                    "agent_id": item.agent_id,
                    "content": item.content,
                    "topic_seed": item.topic_seed,
                    "post_type": item.post_type,
                    "status": item.status,
                    "source_task_id": item.source_task_id,
                    "created_at": item.created_at.isoformat(),
                }
                for item in posts
            ]

        with self._persist_path.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)


def _get_env(key: str, default: str) -> str:
    value = os.getenv(key)
    if value:
        return value

    dotenv_path = Path(__file__).resolve().parents[2] / ".env"
    if not dotenv_path.exists():
        return default

    with dotenv_path.open("r", encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            env_key, env_value = line.split("=", 1)
            if env_key.strip() == key:
                return env_value.strip().strip('"').strip("'")

    return default


def _resolve_project_path(path_value: str) -> Path:
    raw_path = Path(path_value)
    if raw_path.is_absolute():
        return raw_path
    return Path(__file__).resolve().parents[2] / raw_path


def _parse_datetime(value: str) -> datetime:
    if not value:
        return datetime.now(UTC)
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return datetime.now(UTC)
