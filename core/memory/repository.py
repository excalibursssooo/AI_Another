from __future__ import annotations

from datetime import datetime
from typing import Protocol

from core.memory.models import MemoryItem


class MemoryRepository(Protocol):
    """Persistence contract for memory records."""

    def add(self, item: MemoryItem) -> MemoryItem:
        ...

    def list_by_user(self, user_id: str, agent_id: str) -> list[MemoryItem]:
        ...

    def get_by_ids(self, user_id: str, agent_id: str, ids: list[str]) -> list[MemoryItem]:
        ...

    def get_by_id(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        ...

    def set_status(self, user_id: str, agent_id: str, memory_id: str, status: str) -> MemoryItem | None:
        ...

    def touch(self, user_id: str, agent_id: str, memory_ids: list[str]) -> None:
        ...

    def set_conflict_state(self, user_id: str, agent_id: str, memory_id: str, conflict_state: str) -> MemoryItem | None:
        ...

    def replace(
        self,
        user_id: str,
        agent_id: str,
        memory_id: str,
        *,
        content: str,
        confidence: float,
        importance: float,
        status: str,
        conflict_state: str,
    ) -> MemoryItem | None:
        ...


class InMemoryMemoryRepository:
    """Default repository for local development and tests."""

    def __init__(self) -> None:
        self._items_by_user_agent: dict[tuple[str, str], list[MemoryItem]] = {}

    @staticmethod
    def _key(user_id: str, agent_id: str) -> tuple[str, str]:
        return (user_id, agent_id)

    def add(self, item: MemoryItem) -> MemoryItem:
        key = self._key(item.user_id, item.agent_id)
        if key not in self._items_by_user_agent:
            self._items_by_user_agent[key] = []
        self._items_by_user_agent[key].append(item)
        return item

    def list_by_user(self, user_id: str, agent_id: str) -> list[MemoryItem]:
        return list(self._items_by_user_agent.get(self._key(user_id, agent_id), []))

    def get_by_ids(self, user_id: str, agent_id: str, ids: list[str]) -> list[MemoryItem]:
        if not ids:
            return []
        id_set = set(ids)
        return [item for item in self._items_by_user_agent.get(self._key(user_id, agent_id), []) if item.id in id_set]

    def get_by_id(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        for item in self._items_by_user_agent.get(self._key(user_id, agent_id), []):
            if item.id == memory_id:
                return item
        return None

    def set_status(self, user_id: str, agent_id: str, memory_id: str, status: str) -> MemoryItem | None:
        items = self._items_by_user_agent.get(self._key(user_id, agent_id), [])
        for index, item in enumerate(items):
            if item.id != memory_id:
                continue

            updated = MemoryItem(
                id=item.id,
                user_id=item.user_id,
                agent_id=item.agent_id,
                subject=item.subject,
                memory_type=item.memory_type,
                content=item.content,
                confidence=item.confidence,
                importance=item.importance,
                status=status,
                conflict_state=item.conflict_state,
                created_at=item.created_at,
                access_count=item.access_count,
                last_accessed_at=item.last_accessed_at,
            )
            items[index] = updated
            return updated

        return None

    def touch(self, user_id: str, agent_id: str, memory_ids: list[str]) -> None:
        if not memory_ids:
            return

        id_set = set(memory_ids)
        now = datetime.now()
        items = self._items_by_user_agent.get(self._key(user_id, agent_id), [])
        for index, item in enumerate(items):
            if item.id not in id_set:
                continue
            items[index] = MemoryItem(
                id=item.id,
                user_id=item.user_id,
                agent_id=item.agent_id,
                subject=item.subject,
                memory_type=item.memory_type,
                content=item.content,
                confidence=item.confidence,
                importance=item.importance,
                status=item.status,
                conflict_state=item.conflict_state,
                created_at=item.created_at,
                access_count=item.access_count + 1,
                last_accessed_at=now,
            )

    def set_conflict_state(self, user_id: str, agent_id: str, memory_id: str, conflict_state: str) -> MemoryItem | None:
        items = self._items_by_user_agent.get(self._key(user_id, agent_id), [])
        for index, item in enumerate(items):
            if item.id != memory_id:
                continue
            updated = MemoryItem(
                id=item.id,
                user_id=item.user_id,
                agent_id=item.agent_id,
                subject=item.subject,
                memory_type=item.memory_type,
                content=item.content,
                confidence=item.confidence,
                importance=item.importance,
                status=item.status,
                conflict_state=conflict_state,
                created_at=item.created_at,
                access_count=item.access_count,
                last_accessed_at=item.last_accessed_at,
            )
            items[index] = updated
            return updated
        return None

    def replace(
        self,
        user_id: str,
        agent_id: str,
        memory_id: str,
        *,
        content: str,
        confidence: float,
        importance: float,
        status: str,
        conflict_state: str,
    ) -> MemoryItem | None:
        items = self._items_by_user_agent.get(self._key(user_id, agent_id), [])
        for index, item in enumerate(items):
            if item.id != memory_id:
                continue
            updated = MemoryItem(
                id=item.id,
                user_id=item.user_id,
                agent_id=item.agent_id,
                subject=item.subject,
                memory_type=item.memory_type,
                content=content,
                confidence=confidence,
                importance=importance,
                status=status,
                conflict_state=conflict_state,
                created_at=item.created_at,
                access_count=item.access_count,
                last_accessed_at=datetime.now(),
            )
            items[index] = updated
            return updated
        return None


class PostgresMemoryRepository:
    """PostgreSQL repository. Uses psycopg if available."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for PostgresMemoryRepository") from exc

        self._psycopg = psycopg
        self._init_schema()

    def _init_schema(self) -> None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS memory_item (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        agent_id TEXT NOT NULL DEFAULT 'default',
                        subject TEXT NOT NULL DEFAULT 'user',
                        memory_type TEXT NOT NULL,
                        content TEXT NOT NULL,
                        confidence DOUBLE PRECISION NOT NULL,
                        importance DOUBLE PRECISION NOT NULL,
                        status TEXT NOT NULL DEFAULT 'active',
                        conflict_state TEXT NOT NULL DEFAULT 'none',
                        created_at TIMESTAMPTZ NOT NULL,
                        access_count INTEGER NOT NULL DEFAULT 0,
                        last_accessed_at TIMESTAMPTZ
                    );
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'default';
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'user';
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
                    ALTER TABLE memory_item
                    ADD COLUMN IF NOT EXISTS conflict_state TEXT NOT NULL DEFAULT 'none';
                    CREATE INDEX IF NOT EXISTS idx_memory_user_created
                    ON memory_item (user_id, agent_id, created_at DESC);
                    """,
                )
            conn.commit()

    def add(self, item: MemoryItem) -> MemoryItem:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO memory_item (
                        id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                        created_at, access_count, last_accessed_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        item.id,
                        item.user_id,
                        item.agent_id,
                        item.subject,
                        item.memory_type,
                        item.content,
                        item.confidence,
                        item.importance,
                        item.status,
                        item.conflict_state,
                        item.created_at,
                        item.access_count,
                        item.last_accessed_at,
                    ),
                )
            conn.commit()
        return item

    def list_by_user(self, user_id: str, agent_id: str) -> list[MemoryItem]:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    FROM memory_item
                    WHERE user_id = %s AND agent_id = %s
                    ORDER BY created_at DESC
                    """,
                    (user_id, agent_id),
                )
                rows = cur.fetchall()

        return [
            MemoryItem(
                id=row[0],
                user_id=row[1],
                agent_id=row[2],
                subject=row[3],
                memory_type=row[4],
                content=row[5],
                confidence=float(row[6]),
                importance=float(row[7]),
                status=row[8],
                conflict_state=row[9],
                created_at=_ensure_datetime(row[10]),
                access_count=int(row[11]),
                last_accessed_at=_ensure_datetime_or_none(row[12]),
            )
            for row in rows
        ]

    def get_by_ids(self, user_id: str, agent_id: str, ids: list[str]) -> list[MemoryItem]:
        if not ids:
            return []

        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    FROM memory_item
                    WHERE user_id = %s AND agent_id = %s AND id = ANY(%s)
                    """,
                    (user_id, agent_id, ids),
                )
                rows = cur.fetchall()

        return [
            MemoryItem(
                id=row[0],
                user_id=row[1],
                agent_id=row[2],
                subject=row[3],
                memory_type=row[4],
                content=row[5],
                confidence=float(row[6]),
                importance=float(row[7]),
                status=row[8],
                conflict_state=row[9],
                created_at=_ensure_datetime(row[10]),
                access_count=int(row[11]),
                last_accessed_at=_ensure_datetime_or_none(row[12]),
            )
            for row in rows
        ]

    def get_by_id(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    FROM memory_item
                    WHERE user_id = %s AND agent_id = %s AND id = %s
                    """,
                    (user_id, agent_id, memory_id),
                )
                row = cur.fetchone()

        if row is None:
            return None

        return MemoryItem(
            id=row[0],
            user_id=row[1],
            agent_id=row[2],
            subject=row[3],
            memory_type=row[4],
            content=row[5],
            confidence=float(row[6]),
            importance=float(row[7]),
            status=row[8],
            conflict_state=row[9],
            created_at=_ensure_datetime(row[10]),
            access_count=int(row[11]),
            last_accessed_at=_ensure_datetime_or_none(row[12]),
        )

    def set_status(self, user_id: str, agent_id: str, memory_id: str, status: str) -> MemoryItem | None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE memory_item
                    SET status = %s
                    WHERE user_id = %s AND agent_id = %s AND id = %s
                    RETURNING id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    """,
                    (status, user_id, agent_id, memory_id),
                )
                row = cur.fetchone()
            conn.commit()

        if row is None:
            return None

        return MemoryItem(
            id=row[0],
            user_id=row[1],
            agent_id=row[2],
            subject=row[3],
            memory_type=row[4],
            content=row[5],
            confidence=float(row[6]),
            importance=float(row[7]),
            status=row[8],
            conflict_state=row[9],
            created_at=_ensure_datetime(row[10]),
            access_count=int(row[11]),
            last_accessed_at=_ensure_datetime_or_none(row[12]),
        )

    def set_conflict_state(self, user_id: str, agent_id: str, memory_id: str, conflict_state: str) -> MemoryItem | None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE memory_item
                    SET conflict_state = %s
                    WHERE user_id = %s AND agent_id = %s AND id = %s
                    RETURNING id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    """,
                    (conflict_state, user_id, agent_id, memory_id),
                )
                row = cur.fetchone()
            conn.commit()

        if row is None:
            return None

        return MemoryItem(
            id=row[0],
            user_id=row[1],
            agent_id=row[2],
            subject=row[3],
            memory_type=row[4],
            content=row[5],
            confidence=float(row[6]),
            importance=float(row[7]),
            status=row[8],
            conflict_state=row[9],
            created_at=_ensure_datetime(row[10]),
            access_count=int(row[11]),
            last_accessed_at=_ensure_datetime_or_none(row[12]),
        )

    def replace(
        self,
        user_id: str,
        agent_id: str,
        memory_id: str,
        *,
        content: str,
        confidence: float,
        importance: float,
        status: str,
        conflict_state: str,
    ) -> MemoryItem | None:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE memory_item
                    SET content = %s,
                        confidence = %s,
                        importance = %s,
                        status = %s,
                        conflict_state = %s,
                        last_accessed_at = NOW()
                    WHERE user_id = %s AND agent_id = %s AND id = %s
                    RETURNING id, user_id, agent_id, subject, memory_type, content, confidence, importance, status, conflict_state,
                    created_at, access_count, last_accessed_at
                    """,
                    (content, confidence, importance, status, conflict_state, user_id, agent_id, memory_id),
                )
                row = cur.fetchone()
            conn.commit()

        if row is None:
            return None

        return MemoryItem(
            id=row[0],
            user_id=row[1],
            agent_id=row[2],
            subject=row[3],
            memory_type=row[4],
            content=row[5],
            confidence=float(row[6]),
            importance=float(row[7]),
            status=row[8],
            conflict_state=row[9],
            created_at=_ensure_datetime(row[10]),
            access_count=int(row[11]),
            last_accessed_at=_ensure_datetime_or_none(row[12]),
        )

    def touch(self, user_id: str, agent_id: str, memory_ids: list[str]) -> None:
        if not memory_ids:
            return

        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE memory_item
                    SET access_count = access_count + 1,
                        last_accessed_at = NOW()
                    WHERE user_id = %s AND agent_id = %s AND id = ANY(%s)
                    """,
                    (user_id, agent_id, memory_ids),
                )
            conn.commit()


def _ensure_datetime(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def _ensure_datetime_or_none(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    return _ensure_datetime(value)
