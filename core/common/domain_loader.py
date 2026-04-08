from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re


@dataclass
class DomainConfig:
    id: str
    name: str
    lore: str
    tone: str
    constraints: list[str]
    seed_memories: list[str]


def normalize_domain_id(value: str) -> str:
    lowered = value.strip().lower().replace(" ", "_")
    return re.sub(r"[^a-z0-9_-]", "", lowered)


def domain_is_enabled() -> bool:
    raw = _get_env("DOMAIN_ENABLED", "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def get_default_domain_id() -> str:
    return _get_env("DEFAULT_DOMAIN_ID", "default").strip() or "default"


def list_domain_summaries() -> list[dict[str, str]]:
    if not domain_is_enabled():
        return []

    rows: list[dict[str, str]] = []
    for path in sorted(_get_domain_config_dir().glob("*.json")):
        try:
            payload = _load_json(path)
            rows.append(
                {
                    "id": str(payload.get("id", "")).strip(),
                    "name": str(payload.get("name", "")).strip(),
                },
            )
        except Exception:
            continue

    return [item for item in rows if item.get("id")]


def list_domain_configs() -> list[DomainConfig]:
    if not domain_is_enabled():
        return []

    rows: list[DomainConfig] = []
    for path in sorted(_get_domain_config_dir().glob("*.json")):
        try:
            payload = _load_json(path)
            rows.append(_payload_to_config(payload, fallback_id=path.stem))
        except Exception:
            continue
    return rows


def get_domain_config(domain_id: str) -> DomainConfig | None:
    resolved_id = normalize_domain_id(domain_id)
    if not resolved_id or resolved_id == "default":
        return None

    path = _get_domain_config_dir() / f"{resolved_id}.json"
    if not path.exists():
        return None

    payload = _load_json(path)
    return _payload_to_config(payload, fallback_id=resolved_id)


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

    path = _get_domain_config_dir() / f"{domain_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": normalized.id,
        "name": normalized.name,
        "lore": normalized.lore,
        "tone": normalized.tone,
        "constraints": normalized.constraints,
        "seed_memories": normalized.seed_memories,
    }
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")

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

    path = _get_domain_config_dir() / f"{resolved_id}.json"
    if not path.exists():
        return DomainConfig(
            id="default",
            name="默认陪伴域",
            lore="未找到指定异世界配置，已回退到默认陪伴模式。",
            tone="温暖、现实、支持型",
            constraints=[],
            seed_memories=[],
        )

    payload = _load_json(path)
    return _payload_to_config(payload, fallback_id=resolved_id)


def _payload_to_config(payload: dict[str, object], fallback_id: str) -> DomainConfig:
    constraints = payload.get("constraints", [])
    seed_memories = payload.get("seed_memories", [])
    return DomainConfig(
        id=str(payload.get("id", fallback_id)).strip() or fallback_id,
        name=str(payload.get("name", fallback_id)).strip() or fallback_id,
        lore=str(payload.get("lore", "")).strip(),
        tone=str(payload.get("tone", "")).strip(),
        constraints=[str(item).strip() for item in constraints if str(item).strip()] if isinstance(constraints, list) else [],
        seed_memories=[str(item).strip() for item in seed_memories if str(item).strip()]
        if isinstance(seed_memories, list)
        else [],
    )


def _load_json(path: Path) -> dict[str, object]:
    with path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise RuntimeError("domain config must be an object")
    return payload


def _get_domain_config_dir() -> Path:
    raw = _get_env("DOMAIN_CONFIG_DIR", "data/domains")
    path = Path(raw)
    if path.is_absolute():
        return path
    return Path(__file__).resolve().parents[2] / path


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
