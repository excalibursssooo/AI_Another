from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from typing import Mapping
from uuid import uuid4

from core.common.settings import get_env
from core.posts.models import FeedListResult, FeedPost, FeedPublishResult


class FeedService:
    """Stores and manages agent feed posts in PostgreSQL."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        try:
            import psycopg  # type: ignore
            from psycopg.rows import dict_row  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for FeedService") from exc

        self._psycopg = psycopg
        self._dict_row = dict_row
        self._init_schema()

    def _connect(self):  # type: ignore[no-untyped-def]
        return self._psycopg.connect(self._dsn, row_factory=self._dict_row)

    @staticmethod
    def build_from_env() -> "FeedService":
        dsn = get_env("POSTGRES_DSN", "")
        if not dsn:
            raise RuntimeError("POSTGRES_DSN is required for FeedService")
        return FeedService(dsn=dsn)

    def _init_schema(self) -> None:
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM feed_post LIMIT 1")
        except Exception as exc:
            raise RuntimeError("feed_post table missing; run Alembic migrations first") from exc

    def list_posts(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
        include_archived: bool = False,
    ) -> FeedListResult:
        bounded_limit = max(1, min(limit, 100))
        safe_offset = max(0, offset)

        where_clause = "WHERE user_id = %s"
        params: list[object] = [user_id]
        if not include_archived:
            where_clause += " AND status = 'published'"

        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT COUNT(*) AS total_count FROM feed_post {where_clause}",
                    tuple(params),
                )
                count_row = cur.fetchone()
                total = int(count_row["total_count"]) if count_row and count_row.get("total_count") is not None else 0

                cur.execute(
                    f"""
                    SELECT id, user_id, agent_id, content, topic_seed, post_type, status, source_task_id, created_at
                    FROM feed_post
                    {where_clause}
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                    """,
                    tuple(params + [bounded_limit, safe_offset]),
                )
                rows = cur.fetchall()

        sliced = [_row_to_feed_post(row) for row in rows]
        return FeedListResult(
            items=sliced,
            total=total,
            limit=bounded_limit,
            offset=safe_offset,
        )

    def get_post(self, user_id: str, post_id: str) -> FeedPost | None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, agent_id, content, topic_seed, post_type, status, source_task_id, created_at
                    FROM feed_post
                    WHERE user_id = %s AND id = %s
                    """,
                    (user_id, post_id),
                )
                row = cur.fetchone()
        return _row_to_feed_post(row) if row else None

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

        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO feed_post (
                        id, user_id, agent_id, content, topic_seed, post_type, status, source_task_id, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        post.id,
                        post.user_id,
                        post.agent_id,
                        post.content,
                        post.topic_seed,
                        post.post_type,
                        post.status,
                        post.source_task_id,
                        post.created_at,
                    ),
                )
            conn.commit()
        return FeedPublishResult(post=post, skipped=False, reason="published")

    def archive_post(self, user_id: str, post_id: str) -> FeedPost | None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE feed_post
                    SET status = 'archived'
                    WHERE user_id = %s AND id = %s
                    RETURNING id, user_id, agent_id, content, topic_seed, post_type, status, source_task_id, created_at
                    """,
                    (user_id, post_id),
                )
                row = cur.fetchone()
            conn.commit()
        return _row_to_feed_post(row) if row else None


def _row_to_feed_post(row: Mapping[str, Any]) -> FeedPost:
    created_at = row.get("created_at")
    if isinstance(created_at, datetime):
        created_at_value = created_at.astimezone(UTC) if created_at.tzinfo else created_at.replace(tzinfo=UTC)
    else:
        try:
            parsed = datetime.fromisoformat(str(created_at))
            created_at_value = parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except Exception:
            created_at_value = datetime.now(UTC)

    return FeedPost(
        id=str(row.get("id", "")),
        user_id=str(row.get("user_id", "")),
        agent_id=str(row.get("agent_id", "")),
        content=str(row.get("content", "")),
        topic_seed=str(row.get("topic_seed", "")),
        post_type=str(row.get("post_type", "")),
        status=str(row.get("status", "")),
        source_task_id=str(row.get("source_task_id")) if row.get("source_task_id") is not None else None,
        created_at=created_at_value,
    )
