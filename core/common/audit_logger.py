from __future__ import annotations

from datetime import UTC, datetime
import json
import os
from pathlib import Path
from threading import Lock
from typing import Any


class AuditLogger:
    """Thread-safe JSONL audit logger for backend operations and outcomes."""

    def __init__(self, enabled: bool, log_path: Path) -> None:
        self._enabled = enabled
        self._log_path = log_path
        self._lock = Lock()

    @staticmethod
    def from_env() -> "AuditLogger":
        enabled_raw = _get_env("AUDIT_LOG_ENABLED", "true").strip().lower()
        enabled = enabled_raw in {"1", "true", "yes", "on"}

        path_raw = _get_env("AUDIT_LOG_PATH", "logs/audit.jsonl")
        path = Path(path_raw)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path

        return AuditLogger(enabled=enabled, log_path=path)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def log_path(self) -> Path:
        return self._log_path

    def log(self, event: str, **payload: object) -> None:
        if not self._enabled:
            return

        record: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(),
            "event": event,
        }
        record.update(payload)

        with self._lock:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            with self._log_path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")


_logger: AuditLogger | None = None


def get_audit_logger() -> AuditLogger:
    global _logger
    if _logger is None:
        _logger = AuditLogger.from_env()
    return _logger


def audit_log(event: str, **payload: object) -> None:
    logger = get_audit_logger()
    logger.log(event=event, **payload)


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
