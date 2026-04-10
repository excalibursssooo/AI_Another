from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from core.common.settings import get_env


@dataclass
class ConversationTurn:
    role: str
    content: str
    created_at: datetime


class ConversationStore:
    """Stores multi-turn conversation history in PostgreSQL."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for ConversationStore") from exc

        self._psycopg = psycopg
        self._init_schema()

    @staticmethod
    def build_from_env() -> "ConversationStore":
        dsn = get_env("POSTGRES_DSN", "")
        if not dsn:
            raise RuntimeError("POSTGRES_DSN is required for ConversationStore")
        return ConversationStore(dsn=dsn)

    def _init_schema(self) -> None:
        try:
            with self._psycopg.connect(self._dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM conversation_turn LIMIT 1")
        except Exception as exc:
            raise RuntimeError("conversation_turn table missing; run Alembic migrations first") from exc

    def append(self, user_id: str, role: str, content: str) -> None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO conversation_turn (user_id, role, content, created_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (user_id, role, content, datetime.now(UTC)),
                )
            conn.commit()

    def recent(self, user_id: str, limit: int = 8) -> list[ConversationTurn]:
        if limit <= 0:
            return []

        bounded = min(limit, 200)
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT role, content, created_at
                    FROM conversation_turn
                    WHERE user_id = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                    """,
                    (user_id, bounded),
                )
                rows = cur.fetchall()

        turns = [
            ConversationTurn(
                role=str(row[0]),
                content=str(row[1]),
                created_at=_parse_datetime_value(row[2]),
            )
            for row in rows
        ]
        turns.reverse()
        return turns

    def known_user_ids(self) -> list[str]:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT split_part(user_id, ':', 1) AS principal
                    FROM conversation_turn
                    WHERE split_part(user_id, ':', 1) <> ''
                    ORDER BY principal ASC
                    """,
                )
                rows = cur.fetchall()
        return [str(row[0]) for row in rows if row and row[0]]


def _parse_datetime_value(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    if not value:
        return datetime.now(UTC)
    try:
        parsed = datetime.fromisoformat(str(value))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except Exception:
        return datetime.now(UTC)
