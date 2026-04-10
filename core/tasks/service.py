from __future__ import annotations

from datetime import UTC, datetime
import json
from typing import Any
from uuid import uuid4

from core.common.settings import get_env
from core.tasks.models import TaskDraft, TaskItem


class TaskService:
    """Task draft and confirmation flow for MVP."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for TaskService") from exc

        self._psycopg = psycopg
        self._init_schema()

    @staticmethod
    def build_from_env() -> "TaskService":
        dsn = get_env("POSTGRES_DSN", "")
        if not dsn:
            raise RuntimeError("POSTGRES_DSN is required for TaskService")
        return TaskService(dsn=dsn)

    def _init_schema(self) -> None:
        try:
            with self._psycopg.connect(self._dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM task_item LIMIT 1")
        except Exception as exc:
            raise RuntimeError("task_item table missing; run Alembic migrations first") from exc

    def draft_from_message(self, message: str) -> TaskDraft | None:
        trigger_words = ["帮我", "提醒", "计划", "安排", "任务", "todo", "to-do"]
        if not any(word in message.lower() for word in trigger_words):
            return None

        title = message.strip()
        priority = "medium"
        if any(word in message for word in ["紧急", "尽快", "马上"]):
            priority = "high"

        return TaskDraft(
            title=title[:80],
            priority=priority,
            deadline=None,
            subtasks=[],
        )

    def confirm_create(self, user_id: str, draft: TaskDraft, source_message: str) -> TaskItem:
        task = TaskItem(
            id=str(uuid4()),
            user_id=user_id,
            title=draft.title,
            status="pending",
            priority=draft.priority,
            deadline=draft.deadline,
            subtasks=draft.subtasks,
            source_message=source_message,
            created_at=datetime.now(UTC),
        )

        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO task_item (
                        id, user_id, title, status, priority, deadline, subtasks_json, source_message, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        task.id,
                        task.user_id,
                        task.title,
                        task.status,
                        task.priority,
                        task.deadline,
                        json.dumps(task.subtasks, ensure_ascii=False),
                        task.source_message,
                        task.created_at,
                    ),
                )
            conn.commit()
        return task

    def list_tasks(self, user_id: str) -> list[TaskItem]:
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, title, status, priority, deadline, subtasks_json, source_message, created_at
                    FROM task_item
                    WHERE user_id = %s
                    ORDER BY created_at DESC
                    """,
                    (user_id,),
                )
                rows = cur.fetchall()

        return [_row_to_task_item(row) for row in rows]


def _row_to_task_item(row: tuple[Any, ...]) -> TaskItem:
    subtasks: list[str] = []
    subtasks_value = row[6]
    if isinstance(subtasks_value, str) and subtasks_value.strip():
        try:
            decoded = json.loads(subtasks_value)
            if isinstance(decoded, list):
                subtasks = [str(item) for item in decoded if str(item).strip()]
        except Exception:
            subtasks = []

    created_at = row[8]
    if isinstance(created_at, datetime):
        created_at_value = created_at.astimezone(UTC) if created_at.tzinfo else created_at.replace(tzinfo=UTC)
    else:
        try:
            parsed = datetime.fromisoformat(str(created_at))
            created_at_value = parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except Exception:
            created_at_value = datetime.now(UTC)

    return TaskItem(
        id=str(row[0]),
        user_id=str(row[1]),
        title=str(row[2]),
        status=str(row[3]),
        priority=str(row[4]),
        deadline=str(row[5]) if row[5] is not None else None,
        subtasks=subtasks,
        source_message=str(row[7]),
        created_at=created_at_value,
    )
