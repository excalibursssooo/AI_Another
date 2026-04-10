from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import re
from typing import Any

from core.common.settings import get_env


@dataclass
class DomainConfig:
    id: str
    name: str
    lore: str
    tone: str
    constraints: list[str]
    seed_memories: list[str]


_schema_ready = False


def normalize_domain_id(value: str) -> str:
    lowered = value.strip().lower().replace(" ", "_")
    return re.sub(r"[^a-z0-9_-]", "", lowered)


def domain_is_enabled() -> bool:
    raw = get_env("DOMAIN_ENABLED", "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def get_default_domain_id() -> str:
    return get_env("DEFAULT_DOMAIN_ID", "default").strip() or "default"


def list_domain_summaries() -> list[dict[str, str]]:
    if not domain_is_enabled():
        return []

    with _get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM domain_config ORDER BY id ASC")
            rows = cur.fetchall()

    return [{"id": str(row[0]), "name": str(row[1])} for row in rows if row and row[0]]


def list_domain_configs() -> list[DomainConfig]:
    if not domain_is_enabled():
        return []

    with _get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, lore, tone, constraints_json, seed_memories_json
                FROM domain_config
                ORDER BY id ASC
                """,
            )
            rows = cur.fetchall()

    return [_row_to_domain_config(row) for row in rows]


def get_domain_config(domain_id: str) -> DomainConfig | None:
    resolved_id = normalize_domain_id(domain_id)
    if not resolved_id or resolved_id == "default":
        return None

    with _get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, lore, tone, constraints_json, seed_memories_json
                FROM domain_config
                WHERE id = %s
                """,
                (resolved_id,),
            )
            row = cur.fetchone()

    return _row_to_domain_config(row) if row else None


def save_domain_config(config: DomainConfig) -> DomainConfig:
    domain_id = normalize_domain_id(config.id)
    if not domain_id:
        raise ValueError("domain id is required")
    if domain_id == "default":
        raise ValueError("default is reserved")

    normalized = DomainConfig(
        id=domain_id,
        name=config.name.strip() or domain_id,
        lore=config.lore.strip(),
        tone=config.tone.strip(),
        constraints=[item.strip() for item in config.constraints if item.strip()],
        seed_memories=[item.strip() for item in config.seed_memories if item.strip()],
    )

    with _get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO domain_config (
                    id, name, lore, tone, constraints_json, seed_memories_json, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    lore = EXCLUDED.lore,
                    tone = EXCLUDED.tone,
                    constraints_json = EXCLUDED.constraints_json,
                    seed_memories_json = EXCLUDED.seed_memories_json,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    normalized.id,
                    normalized.name,
                    normalized.lore,
                    normalized.tone,
                    json.dumps(normalized.constraints, ensure_ascii=False),
                    json.dumps(normalized.seed_memories, ensure_ascii=False),
                    datetime.now(UTC),
                ),
            )
        conn.commit()

    return normalized


def load_domain_config(domain_id: str | None = None) -> DomainConfig:
    resolved_id = (domain_id or get_default_domain_id()).strip() or get_default_domain_id()
    if not domain_is_enabled() or resolved_id == "default":
        return DomainConfig(
            id="default",
            name="默认陪伴域",
            lore="默认陪伴模式，不启用异世界世界观约束。",
            tone="温暖、现实、支持型",
            constraints=[],
            seed_memories=[],
        )

    found = get_domain_config(resolved_id)
    if found is None:
        return DomainConfig(
            id="default",
            name="默认陪伴域",
            lore="未找到指定异世界配置，已回退到默认陪伴模式。",
            tone="温暖、现实、支持型",
            constraints=[],
            seed_memories=[],
        )

    return found


def _get_connection():  # type: ignore[no-untyped-def]
    global _schema_ready
    dsn = get_env("POSTGRES_DSN", "")
    if not dsn:
        raise RuntimeError("POSTGRES_DSN is required for domain config storage")

    try:
        import psycopg  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("psycopg is required for domain config storage") from exc

    conn = psycopg.connect(dsn)
    if not _schema_ready:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM domain_config LIMIT 1")
            _schema_ready = True
        except Exception as exc:
            conn.close()
            raise RuntimeError("domain_config table missing; run Alembic migrations first") from exc
    return conn


def _parse_json_list(value: Any) -> list[str]:
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
            if isinstance(decoded, list):
                return [str(item).strip() for item in decoded if str(item).strip()]
        except Exception:
            return []
    return []


def _row_to_domain_config(row: tuple[Any, ...]) -> DomainConfig:
    return DomainConfig(
        id=str(row[0]).strip() or "default",
        name=str(row[1]).strip() or str(row[0]).strip() or "default",
        lore=str(row[2] or "").strip(),
        tone=str(row[3] or "").strip(),
        constraints=_parse_json_list(row[4]),
        seed_memories=_parse_json_list(row[5]),
    )
