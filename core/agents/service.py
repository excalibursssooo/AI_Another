from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
import json
from pathlib import Path
from typing import Any
from typing import Mapping
from typing import Protocol
from uuid import uuid4

from core.common.domain_loader import load_domain_config
from core.common.openrouter import OpenRouterError, get_env as get_common_env, get_openrouter_client
from core.common.settings import get_env
from core.agents.models import AgentProfile


class AgentAICreationError(RuntimeError):
    def __init__(self, message: str, debug_info: dict[str, object]) -> None:
        super().__init__(message)
        self.debug_info = debug_info


class AgentRepository(Protocol):
    def create(self, profile: AgentProfile) -> AgentProfile:
        ...

    def list_all(self, include_inactive: bool = False) -> list[AgentProfile]:
        ...

    def get(self, agent_id: str) -> AgentProfile | None:
        ...

    def update(self, agent_id: str, profile: AgentProfile) -> AgentProfile | None:
        ...

    def delete(self, agent_id: str) -> AgentProfile | None:
        ...


class AgentAttributeGenerator(Protocol):
    def generate(self, prompt: str) -> dict[str, object]:
        ...

    def generate_debug(self, prompt: str) -> dict[str, object]:
        ...


class OpenRouterAgentAttributeGenerator:
    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        self._client = get_openrouter_client("AGENT_CREATOR_MODEL_NAME", model_name)

    def generate(self, prompt: str) -> dict[str, object]:
        debug = self.generate_debug(prompt)
        payload_obj = debug.get("payload", {})
        if not isinstance(payload_obj, dict):
            raise RuntimeError("AI output payload is invalid")
        return payload_obj

    def generate_debug(self, prompt: str) -> dict[str, object]:
        text = self._client.chat_text(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是一个专业的角色设计师，你需要构建一个角色，包括他/她的性格、背景、爱好和对话风格,以及见到一个新认识的人的开场白。"
                        "只输出JSON对象, 不要输出其他内容。"
                        "JSON字段: name, display_name, persona, background, hobbies, speaking_style, greeting。"
                        "其中name是角色内部名, display_name是展示给用户的名字, 二者可以不同。"
                        "约束: name<=20字, display_name<=20字, persona<=1000字, background<=500字,"
                        "hobbies为1-6个字符串数组。"
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            max_tokens=4096,
            temperature=0.7,
        )

        parse_error = ""
        normalized: dict[str, object] | None = None
        try:
            payload = _parse_json_object(text)
            normalized = _normalize_agent_payload(payload)
        except Exception as exc:
            parse_error = str(exc)

        return {
            "backend": "openrouter",
            "model": self._model_name,
            "prompt": prompt,
            "raw_text": text,
            "payload": normalized,
            "parse_error": parse_error,
        }

    def expand_world_context(self, *, lore: str, tone: str, constraints: list[str]) -> str:
        if not lore.strip():
            return ""

        constraints_text = "\n".join(f"- {item}" for item in constraints[:8]) if constraints else "- 无"
        text = self._client.chat_text(
            messages=[
                {
                    "role": "system",
                    "content": "你是世界观编辑器。请把给定设定压缩成120-180字角色创建基底, 只输出纯文本。",
                },
                {
                    "role": "user",
                    "content": (
                        f"世界观原文:\n{lore}\n"
                        f"语气风格: {tone or '中性'}\n"
                        f"约束规则:\n{constraints_text}\n"
                        "请输出可直接放进角色创建提示词的世界基底。"
                    ),
                },
            ],
            max_tokens=2048,
            temperature=0.3,
        )
        return text.strip()


class InMemoryAgentRepository:
    def __init__(self) -> None:
        self._agents: dict[str, AgentProfile] = {}

    def create(self, profile: AgentProfile) -> AgentProfile:
        self._agents[profile.id] = deepcopy(profile)
        return deepcopy(profile)

    def list_all(self, include_inactive: bool = False) -> list[AgentProfile]:
        rows = list(self._agents.values())
        if not include_inactive:
            rows = [item for item in rows if item.status == "active"]
        rows.sort(key=lambda item: item.updated_at, reverse=True)
        return [deepcopy(item) for item in rows]

    def get(self, agent_id: str) -> AgentProfile | None:
        item = self._agents.get(agent_id)
        return deepcopy(item) if item else None

    def update(self, agent_id: str, profile: AgentProfile) -> AgentProfile | None:
        if agent_id not in self._agents:
            return None
        self._agents[agent_id] = deepcopy(profile)
        return deepcopy(profile)

    def delete(self, agent_id: str) -> AgentProfile | None:
        existing = self._agents.get(agent_id)
        if existing is None:
            return None
        del self._agents[agent_id]
        return deepcopy(existing)


class PostgresAgentRepository:
    """PostgreSQL-backed repository for agent profiles."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        try:
            import psycopg  # type: ignore
            from psycopg.rows import dict_row  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("psycopg is required for PostgresAgentRepository") from exc

        self._psycopg = psycopg
        self._dict_row = dict_row
        self._init_schema()

    def _connect(self):  # type: ignore[no-untyped-def]
        return self._psycopg.connect(self._dsn, row_factory=self._dict_row)

    def _init_schema(self) -> None:
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM agent_profile LIMIT 1")
        except Exception as exc:
            raise RuntimeError("agent_profile table missing; run Alembic migrations first") from exc


    def create(self, profile: AgentProfile) -> AgentProfile:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO agent_profile (
                        id, name, display_name, persona, background, domain_id, world_context,
                        greeting, hobbies_json, speaking_style, status, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        display_name = EXCLUDED.display_name,
                        persona = EXCLUDED.persona,
                        background = EXCLUDED.background,
                        domain_id = EXCLUDED.domain_id,
                        world_context = EXCLUDED.world_context,
                        greeting = EXCLUDED.greeting,
                        hobbies_json = EXCLUDED.hobbies_json,
                        speaking_style = EXCLUDED.speaking_style,
                        status = EXCLUDED.status,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        profile.id,
                        profile.name,
                        profile.display_name or profile.name,
                        profile.persona,
                        profile.background,
                        profile.domain_id,
                        profile.world_context,
                        profile.greeting,
                        json.dumps(profile.hobbies, ensure_ascii=False),
                        profile.speaking_style,
                        profile.status,
                        profile.created_at,
                        profile.updated_at,
                    ),
                )
            conn.commit()
        return self.get(profile.id) or profile

    def list_all(self, include_inactive: bool = False) -> list[AgentProfile]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                if include_inactive:
                    cur.execute(
                        """
                        SELECT id, name, display_name, persona, background, domain_id, world_context,
                               greeting, hobbies_json, speaking_style, status, created_at, updated_at
                        FROM agent_profile
                        ORDER BY updated_at DESC
                        """,
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, name, display_name, persona, background, domain_id, world_context,
                               greeting, hobbies_json, speaking_style, status, created_at, updated_at
                        FROM agent_profile
                        WHERE status = 'active'
                        ORDER BY updated_at DESC
                        """,
                    )
                rows = cur.fetchall()
        return [_row_to_agent_profile(row) for row in rows]

    def get(self, agent_id: str) -> AgentProfile | None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, name, display_name, persona, background, domain_id, world_context,
                           greeting, hobbies_json, speaking_style, status, created_at, updated_at
                    FROM agent_profile
                    WHERE id = %s
                    """,
                    (agent_id,),
                )
                row = cur.fetchone()
        return _row_to_agent_profile(row) if row else None

    def update(self, agent_id: str, profile: AgentProfile) -> AgentProfile | None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE agent_profile
                    SET name = %s,
                        display_name = %s,
                        persona = %s,
                        background = %s,
                        domain_id = %s,
                        world_context = %s,
                        greeting = %s,
                        hobbies_json = %s,
                        speaking_style = %s,
                        status = %s,
                        updated_at = %s
                    WHERE id = %s
                    """,
                    (
                        profile.name,
                        profile.display_name or profile.name,
                        profile.persona,
                        profile.background,
                        profile.domain_id,
                        profile.world_context,
                        profile.greeting,
                        json.dumps(profile.hobbies, ensure_ascii=False),
                        profile.speaking_style,
                        profile.status,
                        profile.updated_at,
                        agent_id,
                    ),
                )
                changed = cur.rowcount
            conn.commit()
        if changed <= 0:
            return None
        return self.get(agent_id)

    def delete(self, agent_id: str) -> AgentProfile | None:
        existing = self.get(agent_id)
        if existing is None:
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM agent_profile WHERE id = %s", (agent_id,))
            conn.commit()
        return existing


class AgentService:
    """Manages AI personas for multi-character chat."""

    def __init__(self, repository: AgentRepository, generator: AgentAttributeGenerator | None = None) -> None:
        self.repository = repository
        self.generator = generator
        self._ensure_default_agent()

    @staticmethod
    def build_default() -> "AgentService":
        api_key = get_env("OPENROUTER_API_KEY", "")
        model_name = get_env("AGENT_CREATOR_MODEL_NAME", get_env("CHAT_MODEL_NAME", "openai/gpt-5.2"))
        generator: AgentAttributeGenerator | None = None
        if api_key:
            try:
                generator = OpenRouterAgentAttributeGenerator(model_name=model_name)
            except Exception:
                generator = None
        return AgentService(repository=InMemoryAgentRepository(), generator=generator)

    @staticmethod
    def build_from_env() -> "AgentService":
        api_key = get_env("OPENROUTER_API_KEY", "")
        model_name = get_env("AGENT_CREATOR_MODEL_NAME", get_env("CHAT_MODEL_NAME", "openai/gpt-5.2"))
        generator: AgentAttributeGenerator | None = None
        if api_key:
            try:
                generator = OpenRouterAgentAttributeGenerator(model_name=model_name)
            except Exception:
                generator = None

        dsn = get_env("POSTGRES_DSN", "")
        if not dsn:
            raise RuntimeError("POSTGRES_DSN is required for AgentService")
        repository: AgentRepository = PostgresAgentRepository(dsn=dsn)

        return AgentService(repository=repository, generator=generator)

    def create_agent(
        self,
        name: str,
        persona: str,
        background: str,
        hobbies: list[str],
        speaking_style: str,
        display_name: str | None = None,
        domain_id: str = "default",
        world_context: str = "",
        greeting: str = ""
    ) -> AgentProfile:
        now = datetime.now(UTC)
        profile = AgentProfile(
            id=str(uuid4()),
            name=name,
            persona=persona,
            background=background,
            domain_id=domain_id,
            world_context=world_context,
            greeting=greeting or f"你好，我是{name}",
            display_name=(display_name or name),
            hobbies=hobbies,
            speaking_style=speaking_style,
            status="active",
            created_at=now,
            updated_at=now,
        )
        return self.repository.create(profile)

    def create_agent_by_ai(self, prompt: str, domain_id: str = "default") -> AgentProfile:
        profile, _ = self.create_agent_by_ai_debug(prompt, domain_id=domain_id)
        return profile

    def create_agent_by_ai_debug(
        self,
        prompt: str | None = None,
        domain_id: str = "default",
    ) -> tuple[AgentProfile, dict[str, object]]:
        if self.generator is None:
            raise RuntimeError("AI agent creator unavailable: missing api key or model client")

        domain = load_domain_config(domain_id)
        world_context = domain.lore
        if isinstance(self.generator, OpenRouterAgentAttributeGenerator) and domain.id != "default":
            try:
                expanded = self.generator.expand_world_context(
                    lore=domain.lore,
                    tone=domain.tone,
                    constraints=domain.constraints,
                )
                if expanded:
                    world_context = expanded
            except Exception:
                world_context = domain.lore

        constraints_text = "\n".join(f"- {item}" for item in domain.constraints[:8]) if domain.constraints else "- 无"
        resolved_prompt = (
            prompt.strip()
            if isinstance(prompt, str) and prompt.strip()
            else "请你在给定世界观的情况下自行随机创建一个角色，角色的姓名、性格、背景、爱好和说话方式全部由你自行决定。"
        )

        prompt_with_domain = resolved_prompt
        if domain.id != "default":
            prompt_with_domain = (
                f"[世界域]{domain.id}({domain.name})[/世界域]\n"
                f"[世界背景]{world_context}[/世界背景]\n"
                f"[世界语气]{domain.tone}[/世界语气]\n"
                f"[世界约束]\n{constraints_text}\n[/世界约束]\n"
                f"[角色需求]{resolved_prompt}[/角色需求]"
            )

        debug_info = self.generator.generate_debug(prompt_with_domain)
        debug_info["domain_id"] = domain.id
        debug_info["domain_name"] = domain.name
        debug_info["world_context"] = world_context

        payload_obj = debug_info.get("payload", {})
        if not isinstance(payload_obj, dict):
            parse_error = str(debug_info.get("parse_error", ""))
            message = "AI output payload is invalid"
            if parse_error:
                message = f"AI output payload is invalid: {parse_error}"
            raise AgentAICreationError(message=message, debug_info=debug_info)

        payload = payload_obj
        hobbies_obj = payload.get("hobbies", [])
        hobbies: list[str]
        if isinstance(hobbies_obj, list):
            hobbies = [str(item) for item in hobbies_obj]
        else:
            hobbies = []

        profile = self.create_agent(
            name=str(payload["name"]),
            persona=str(payload["persona"]),
            background=str(payload["background"]),
            hobbies=hobbies,
            speaking_style=str(payload["speaking_style"]),
            greeting=str(payload.get("greeting", f"你好，我是{payload['name']}")).strip(),
            display_name=str(payload.get("display_name", payload["name"])),
            domain_id=domain.id,
            world_context=world_context,
        )
        return profile, debug_info

    def list_agents(self, include_inactive: bool = False, domain_id: str | None = None) -> list[AgentProfile]:
        rows = self.repository.list_all(include_inactive=include_inactive)
        if domain_id is None:
            return rows

        resolved_domain = domain_id.strip() or "default"
        return [item for item in rows if (item.domain_id or "default") == resolved_domain]

    def get_agent(self, agent_id: str) -> AgentProfile | None:
        return self.repository.get(agent_id)

    def update_agent(
        self,
        agent_id: str,
        name: str,
        persona: str,
        background: str,
        hobbies: list[str],
        speaking_style: str,
        status: str,
        domain_id: str | None = None,
    ) -> AgentProfile | None:
        current = self.repository.get(agent_id)
        if current is None:
            return None

        updated = replace(
            current,
            name=name,
            persona=persona,
            background=background,
            hobbies=hobbies,
            speaking_style=speaking_style,
            status=status,
            domain_id=domain_id or current.domain_id,
            updated_at=datetime.now(UTC),
        )
        return self.repository.update(agent_id=agent_id, profile=updated)

    def delete_agent(self, agent_id: str) -> AgentProfile | None:
        if agent_id == "default":
            raise RuntimeError("default agent cannot be deleted")
        return self.repository.delete(agent_id)

    def _ensure_default_agent(self) -> None:
        existing = self.repository.list_all(include_inactive=True)
        if existing:
            return

        now = datetime.now(UTC)
        self.repository.create(
            AgentProfile(
                id="default",
                name="小伴",
                display_name="小伴",
                persona="温暖、耐心、稳定",
                background="长期陪伴型AI助手，擅长倾听与共情",
                domain_id="default",
                world_context="",
                hobbies=["阅读", "散步", "写日记"],
                greeting="你好，我是小伴，很高兴认识你！",
                speaking_style="warm",
                status="active",
                created_at=now,
                updated_at=now,
            ),
        )

def _extract_message_text(raw_message: object) -> str:
    if hasattr(raw_message, "content"):
        content = getattr(raw_message, "content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    value = item.get("text")
                    if isinstance(value, str):
                        parts.append(value)
            return "\n".join(parts).strip()

    if isinstance(raw_message, dict):
        content = raw_message.get("content")
        if isinstance(content, str):
            return content.strip()

    return ""


def _parse_json_object(text: str) -> dict[str, object]:
    raw = text.strip()
    if not raw:
        raise RuntimeError("AI output is empty")

    candidates: list[str] = [raw]

    # Support fenced outputs like ```json ... ```
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        fenced_body = "\n".join(lines).strip()
        if fenced_body:
            candidates.append(fenced_body)

    # If model adds surrounding prose, try extracting the first JSON object block.
    first_left = raw.find("{")
    last_right = raw.rfind("}")
    if first_left != -1 and last_right != -1 and last_right > first_left:
        candidates.append(raw[first_left : last_right + 1].strip())

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue

        if isinstance(parsed, dict):
            return parsed

        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            return parsed[0]

    raise RuntimeError("AI output is not valid JSON object")


def _normalize_agent_payload(payload: dict[str, object]) -> dict[str, object]:
    name = str(payload.get("name", "AI角色")).strip()[:20]
    display_name = str(payload.get("display_name", name or "AI角色")).strip()[:20]
    persona = str(payload.get("persona", "温暖、耐心、稳定")).strip()[:1000]
    background = str(payload.get("background", "长期陪伴型AI助手")).strip()[:500]

    hobbies_obj = payload.get("hobbies", [])
    hobbies: list[str] = []
    if isinstance(hobbies_obj, list):
        for item in hobbies_obj[:6]:
            value = str(item).strip()
            if value:
                hobbies.append(value)

    if not hobbies:
        hobbies = ["阅读", "散步"]

    style = str(payload.get("speaking_style", "warm")).strip().lower()
    greeting = str(payload.get("greeting", f"你好，我是{display_name or name or 'AI角色'}")).strip()[:200]


    return {
        "name": name or "AI角色",
        "display_name": display_name or name or "AI角色",
        "persona": persona or "温暖、耐心、稳定",
        "background": background or "长期陪伴型AI助手",
        "greeting": greeting or f"你好，我是{display_name or name or 'AI角色'}",
        "hobbies": hobbies,
        "speaking_style": style,
    }


def _row_to_agent_profile(row: Mapping[str, Any]) -> AgentProfile:
    hobbies_value = row.get("hobbies_json")
    hobbies: list[str] = []
    if isinstance(hobbies_value, str) and hobbies_value.strip():
        try:
            decoded = json.loads(hobbies_value)
            if isinstance(decoded, list):
                hobbies = [str(item) for item in decoded if str(item).strip()]
        except Exception:
            hobbies = []

    row_name = str(row.get("name", ""))
    row_display_name = str(row.get("display_name", ""))

    return AgentProfile(
        id=str(row.get("id", "")),
        name=row_name,
        display_name=row_display_name or row_name,
        persona=str(row.get("persona", "")),
        background=str(row.get("background", "")),
        domain_id=str(row.get("domain_id", "default")) or "default",
        world_context=str(row.get("world_context") or ""),
        greeting=str(row.get("greeting") or "").strip() or f"你好，我是{row_display_name or row_name}",
        hobbies=hobbies,
        speaking_style=str(row.get("speaking_style") or "warm"),
        status=str(row.get("status") or "active"),
        created_at=_parse_datetime(str(row.get("created_at"))) if row.get("created_at") is not None else datetime.now(UTC),
        updated_at=_parse_datetime(str(row.get("updated_at"))) if row.get("updated_at") is not None else datetime.now(UTC),
    )


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
