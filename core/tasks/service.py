from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import os
from uuid import uuid4

from core.tasks.models import TaskDraft, TaskItem


class TaskService:
    """Task draft and confirmation flow for MVP."""

    def __init__(self, persist_path: Path | None = None) -> None:
        self._tasks_by_user: dict[str, list[TaskItem]] = {}
        self._persist_path = persist_path
        self._load()

    @staticmethod
    def build_from_env() -> "TaskService":
        repository = _get_env("TASK_REPOSITORY", "json")
        if repository != "json":
            return TaskService()

        path_value = _get_env("TASK_JSON_PATH", "data/tasks.json")
        return TaskService(persist_path=_resolve_project_path(path_value))

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
        if user_id not in self._tasks_by_user:
            self._tasks_by_user[user_id] = []
        self._tasks_by_user[user_id].append(task)
        self._save()
        return task

    def list_tasks(self, user_id: str) -> list[TaskItem]:
        return self._tasks_by_user.get(user_id, [])

    def _load(self) -> None:
        if self._persist_path is None or not self._persist_path.exists():
            return

        with self._persist_path.open("r", encoding="utf-8") as file:
            raw = json.load(file)

        if not isinstance(raw, dict):
            return

        loaded: dict[str, list[TaskItem]] = {}
        for user_id, rows in raw.items():
            if not isinstance(user_id, str) or not isinstance(rows, list):
                continue

            tasks: list[TaskItem] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                try:
                    tasks.append(
                        TaskItem(
                            id=str(row.get("id", "")).strip(),
                            user_id=str(row.get("user_id", user_id)).strip(),
                            title=str(row.get("title", "")).strip(),
                            status=str(row.get("status", "pending")).strip() or "pending",
                            priority=str(row.get("priority", "medium")).strip() or "medium",
                            deadline=str(row.get("deadline", "")).strip() or None,
                            subtasks=[str(item) for item in row.get("subtasks", [])]
                            if isinstance(row.get("subtasks"), list)
                            else [],
                            source_message=str(row.get("source_message", "")).strip(),
                            created_at=_parse_datetime(str(row.get("created_at", ""))),
                        ),
                    )
                except Exception:
                    continue

            loaded[user_id] = tasks

        self._tasks_by_user = loaded

    def _save(self) -> None:
        if self._persist_path is None:
            return

        self._persist_path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, list[dict[str, object]]] = {}
        for user_id, tasks in self._tasks_by_user.items():
            payload[user_id] = [
                {
                    "id": item.id,
                    "user_id": item.user_id,
                    "title": item.title,
                    "status": item.status,
                    "priority": item.priority,
                    "deadline": item.deadline,
                    "subtasks": item.subtasks,
                    "source_message": item.source_message,
                    "created_at": item.created_at.isoformat(),
                }
                for item in tasks
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
