from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path


@dataclass
class ConversationTurn:
    role: str
    content: str
    created_at: datetime


class ConversationStore:
    """Stores multi-turn conversation history per user."""

    def __init__(self, persist_path: Path | None = None) -> None:
        self._turns_by_user: dict[str, list[ConversationTurn]] = {}
        self._persist_path = persist_path
        self._load()

    @staticmethod
    def build_from_env() -> "ConversationStore":
        repository = _get_env("CONVERSATION_REPOSITORY", "json")
        if repository != "json":
            return ConversationStore()

        path_value = _get_env("CONVERSATION_JSON_PATH", "data/conversations.json")
        return ConversationStore(persist_path=_resolve_project_path(path_value))

    def append(self, user_id: str, role: str, content: str) -> None:
        if user_id not in self._turns_by_user:
            self._turns_by_user[user_id] = []

        self._turns_by_user[user_id].append(
            ConversationTurn(
                role=role,
                content=content,
                created_at=datetime.now(UTC),
            ),
        )
        self._save()

    def recent(self, user_id: str, limit: int = 8) -> list[ConversationTurn]:
        turns = self._turns_by_user.get(user_id, [])
        if limit <= 0:
            return []
        return turns[-limit:]

    def known_user_ids(self) -> list[str]:
        users: set[str] = set()
        for key in self._turns_by_user:
            if not key:
                continue
            if ":" in key:
                user_id, _ = key.split(":", 1)
                if user_id:
                    users.add(user_id)
                continue
            users.add(key)
        return sorted(users)

    def _load(self) -> None:
        if self._persist_path is None or not self._persist_path.exists():
            return

        with self._persist_path.open("r", encoding="utf-8") as file:
            raw = json.load(file)

        if not isinstance(raw, dict):
            return

        loaded: dict[str, list[ConversationTurn]] = {}
        for user_id, rows in raw.items():
            if not isinstance(user_id, str) or not isinstance(rows, list):
                continue

            turns: list[ConversationTurn] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                role = str(row.get("role", "")).strip()
                content = str(row.get("content", "")).strip()
                if not role:
                    continue
                turns.append(
                    ConversationTurn(
                        role=role,
                        content=content,
                        created_at=_parse_datetime(str(row.get("created_at", ""))),
                    ),
                )

            loaded[user_id] = turns

        self._turns_by_user = loaded

    def _save(self) -> None:
        if self._persist_path is None:
            return

        self._persist_path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, list[dict[str, str]]] = {}
        for user_id, turns in self._turns_by_user.items():
            payload[user_id] = [
                {
                    "role": item.role,
                    "content": item.content,
                    "created_at": item.created_at.isoformat(),
                }
                for item in turns
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
