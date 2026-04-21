from __future__ import annotations

from datetime import UTC, datetime
import json
from threading import Lock
from typing import Any

from core.common.settings import get_env


class AuditLogger:
    """Thread-safe PostgreSQL audit logger for backend operations and outcomes."""

    def __init__(self, enabled: bool, dsn: str) -> None:
        self._enabled = enabled
        self._dsn = dsn
        self._lock = Lock()
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for AuditLogger") from exc
        self._psycopg = psycopg

    @staticmethod
    def from_env() -> "AuditLogger":
        enabled_raw = get_env("AUDIT_LOG_ENABLED", "true").strip().lower()
        enabled = enabled_raw in {"1", "true", "yes", "on"}
        dsn = get_env("POSTGRES_DSN", "")
        if not dsn:
            raise RuntimeError("POSTGRES_DSN is required for AuditLogger")
        return AuditLogger(enabled=enabled, dsn=dsn)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def log_path(self) -> str:
        return "postgres://audit_log"

    def log(self, event: str, **payload: object) -> None:
        if not self._enabled:
            return

        record: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(),
            "event": event,
        }
        record.update(payload)

        serialized = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with self._psycopg.connect(self._dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO audit_log (ts, event, payload_json)
                        VALUES (%s, %s, %s)
                        """,
                        (datetime.now(UTC), event, serialized),
                    )
                conn.commit()

    def list_recent(self, limit: int = 200) -> list[dict[str, object]]:
        bounded = max(1, min(limit, 1000))
        with self._psycopg.connect(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT payload_json
                    FROM audit_log
                    ORDER BY ts DESC
                    LIMIT %s
                    """,
                    (bounded,),
                )
                rows = cur.fetchall()

        result: list[dict[str, object]] = []
        for row in reversed(rows):
            raw = row[0]
            if not isinstance(raw, str):
                continue
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    result.append({str(key): value for key, value in parsed.items()})
            except Exception:
                result.append({"raw": raw})
        return result


_logger: AuditLogger | None = None


def get_audit_logger() -> AuditLogger:
    global _logger
    if _logger is None:
        _logger = AuditLogger.from_env()
    return _logger


def audit_log(event: str, **payload: object) -> None:
    logger = get_audit_logger()
    logger.log(event=event, **payload)
