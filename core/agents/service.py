from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
import json
import os
from pathlib import Path
from typing import Any
from typing import Protocol
from uuid import uuid4

from core.common.openrouter import OpenRouterError, get_env as get_common_env, get_openrouter_client
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
                        "你是一个专业的角色设计师，你需要构建一个角色，包括他/她的性格、背景、爱好和对话风格。"
                        "只输出JSON对象，不要输出其他内容。"
                        "JSON字段: name, display_name, persona, background, hobbies, speaking_style。"
                        "其中name是角色内部名，display_name是展示给用户的名字，二者可以不同。"
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


class JsonFileAgentRepository:
    """JSON-backed repository so agent data survives process restarts."""

    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path
        self._agents: dict[str, AgentProfile] = {}
        self._load()

    def create(self, profile: AgentProfile) -> AgentProfile:
        self._agents[profile.id] = deepcopy(profile)
        self._save()
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
        self._save()
        return deepcopy(profile)

    def delete(self, agent_id: str) -> AgentProfile | None:
        existing = self._agents.get(agent_id)
        if existing is None:
            return None
        del self._agents[agent_id]
        self._save()
        return deepcopy(existing)

    def _load(self) -> None:
        if not self._file_path.exists():
            return

        with self._file_path.open("r", encoding="utf-8") as file:
            raw = json.load(file)

        if not isinstance(raw, list):
            return

        loaded: dict[str, AgentProfile] = {}
        for row in raw:
            if not isinstance(row, dict):
                continue
            try:
                profile = AgentProfile(
                    id=str(row.get("id", "")).strip(),
                    name=str(row.get("name", "")).strip(),
                    persona=str(row.get("persona", "")).strip(),
                    background=str(row.get("background", "")).strip(),
                    display_name=str(row.get("display_name", row.get("name", ""))).strip(),
                    hobbies=[str(item) for item in row.get("hobbies", [])] if isinstance(row.get("hobbies"), list) else [],
                    speaking_style=str(row.get("speaking_style", "warm")).strip() or "warm",
                    status=str(row.get("status", "active")).strip() or "active",
                    created_at=_parse_datetime(str(row.get("created_at", ""))),
                    updated_at=_parse_datetime(str(row.get("updated_at", ""))),
                )
            except Exception:
                continue

            if profile.id:
                loaded[profile.id] = profile

        self._agents = loaded

    def _save(self) -> None:
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = [
            {
                "id": item.id,
                "name": item.name,
                "display_name": item.display_name,
                "persona": item.persona,
                "background": item.background,
                "hobbies": item.hobbies,
                "speaking_style": item.speaking_style,
                "status": item.status,
                "created_at": item.created_at.isoformat(),
                "updated_at": item.updated_at.isoformat(),
            }
            for item in self._agents.values()
        ]
        with self._file_path.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)


class AgentService:
    """Manages AI personas for multi-character chat."""

    def __init__(self, repository: AgentRepository, generator: AgentAttributeGenerator | None = None) -> None:
        self.repository = repository
        self.generator = generator
        self._ensure_default_agent()

    @staticmethod
    def build_default() -> "AgentService":
        api_key = _get_env("OPENROUTER_API_KEY", "")
        model_name = _get_env("AGENT_CREATOR_MODEL_NAME", _get_env("CHAT_MODEL_NAME", "openai/gpt-5.2"))
        generator: AgentAttributeGenerator | None = None
        if api_key:
            try:
                generator = OpenRouterAgentAttributeGenerator(model_name=model_name)
            except Exception:
                generator = None
        return AgentService(repository=InMemoryAgentRepository(), generator=generator)

    @staticmethod
    def build_from_env() -> "AgentService":
        api_key = _get_env("OPENROUTER_API_KEY", "")
        model_name = _get_env("AGENT_CREATOR_MODEL_NAME", _get_env("CHAT_MODEL_NAME", "openai/gpt-5.2"))
        generator: AgentAttributeGenerator | None = None
        if api_key:
            try:
                generator = OpenRouterAgentAttributeGenerator(model_name=model_name)
            except Exception:
                generator = None

        repository_kind = _get_env("AGENT_REPOSITORY", "json")
        if repository_kind == "json":
            path_value = _get_env("AGENT_JSON_PATH", "data/agents.json")
            file_path = _resolve_project_path(path_value)
            repository: AgentRepository = JsonFileAgentRepository(file_path=file_path)
        else:
            repository = InMemoryAgentRepository()

        return AgentService(repository=repository, generator=generator)

    def create_agent(
        self,
        name: str,
        persona: str,
        background: str,
        hobbies: list[str],
        speaking_style: str,
        display_name: str | None = None,
    ) -> AgentProfile:
        now = datetime.now(UTC)
        profile = AgentProfile(
            id=str(uuid4()),
            name=name,
            persona=persona,
            background=background,
            display_name=(display_name or name),
            hobbies=hobbies,
            speaking_style=speaking_style,
            status="active",
            created_at=now,
            updated_at=now,
        )
        return self.repository.create(profile)

    def create_agent_by_ai(self, prompt: str) -> AgentProfile:
        profile, _ = self.create_agent_by_ai_debug(prompt)
        return profile

    def create_agent_by_ai_debug(self, prompt: str | None = None) -> tuple[AgentProfile, dict[str, object]]:
        if self.generator is None:
            raise RuntimeError("AI agent creator unavailable: missing api key or model client")

        resolved_prompt = (
            prompt.strip()
            if isinstance(prompt, str) and prompt.strip()
            else "请你自行随机创建一个角色，他可以与众不同，也可以跟随主流，角色的姓名、性格、背景、爱好和说话方式全部由你自行决定，要求真实、多样、可长期对话。你不许调用缓存，角色需要有独特性，不能和之前创建过的角色重复。"
        )
        debug_info = self.generator.generate_debug(resolved_prompt)

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
            display_name=str(payload.get("display_name", payload["name"])),
        )
        return profile, debug_info

    def list_agents(self, include_inactive: bool = False) -> list[AgentProfile]:
        return self.repository.list_all(include_inactive=include_inactive)

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
                hobbies=["阅读", "散步", "写日记"],
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


    return {
        "name": name or "AI角色",
        "display_name": display_name or name or "AI角色",
        "persona": persona or "温暖、耐心、稳定",
        "background": background or "长期陪伴型AI助手",
        "hobbies": hobbies,
        "speaking_style": style,
    }


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
