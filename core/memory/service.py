from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from pydantic import SecretStr

from core.agents.models import AgentProfile
from core.memory.embedding import SimpleEmbeddingModel
from core.memory.models import MemoryCandidate, MemoryItem
from core.memory.repository import InMemoryMemoryRepository, MemoryRepository, PostgresMemoryRepository
from core.memory.vector_store import InMemoryVectorStore, QdrantVectorStore, VectorStore


AGENT_PROFILE_MEMORY_USER_ID = "__agent_profile__"


@dataclass
class MemoryBackendConfig:
    repository: str
    vector: str
    extraction_backend: str
    extraction_model_name: str

    @staticmethod
    def from_env() -> "MemoryBackendConfig":
        return MemoryBackendConfig(
            repository=_get_env("MEMORY_REPOSITORY", "memory"),
            vector=_get_env("MEMORY_VECTOR", "memory"),
            extraction_backend=_get_env("MEMORY_EXTRACTION_BACKEND", "rule"),
            extraction_model_name=_get_env("MEMORY_EXTRACTION_MODEL_NAME", "glm-4.7-flash"),
        )


class MemoryExtractor(Protocol):
    def extract(self, message: str) -> list[MemoryCandidate]:
        ...

    def extract_debug(self, message: str) -> dict[str, object]:
        ...


class RuleMemoryExtractor:
    """Rule-based extractor for local/offline mode."""

    def extract(self, message: str) -> list[MemoryCandidate]:
        candidates: list[MemoryCandidate] = []
        lower_message = message.lower()

        if "喜欢" in message or "不喜欢" in message:
            candidates.append(
                MemoryCandidate(
                    subject="user",
                    memory_type="preference",
                    content=message,
                    confidence=0.72,
                    importance=0.6,
                ),
            )

        if "目标" in message or "计划" in message:
            candidates.append(
                MemoryCandidate(
                    subject="user",
                    memory_type="goal",
                    content=message,
                    confidence=0.75,
                    importance=0.8,
                ),
            )

        if "我是" in message or "我叫" in message or "my name is" in lower_message:
            candidates.append(
                MemoryCandidate(
                    subject="user",
                    memory_type="profile",
                    content=message,
                    confidence=0.9,
                    importance=0.7,
                ),
            )

        return candidates

    def extract_debug(self, message: str) -> dict[str, object]:
        candidates = self.extract(message)
        return {
            "backend": "rule",
            "model": "rule-based",
            "is_llm": False,
            "system_prompt": "",
            "user_content": message,
            "raw_response": "",
            "raw_text": "",
            "candidates": [
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                    "confidence": item.confidence,
                    "importance": item.importance,
                }
                for item in candidates
            ],
        }


class ZhipuMemoryExtractor:
    """LLM-based extractor for conversational memory judgment."""

    def __init__(self, api_key: str, model_name: str) -> None:
        try:
            from zai import ZhipuAiClient  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("zai-sdk is required for ZhipuMemoryExtractor") from exc

        self._client = ZhipuAiClient(api_key=api_key)
        self._model_name = model_name

    def extract(self, message: str) -> list[MemoryCandidate]:
        _, _, _, _, candidates = self._extract_with_raw(message)
        return candidates

    def extract_debug(self, message: str) -> dict[str, object]:
        system_prompt, user_content, raw_response, raw_text, candidates = self._extract_with_raw(message)
        return {
            "backend": "zhipu",
            "model": self._model_name,
            "is_llm": True,
            "system_prompt": system_prompt,
            "user_content": user_content,
            "raw_response": raw_response,
            "raw_text": raw_text,
            "candidates": [
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                    "confidence": item.confidence,
                    "importance": item.importance,
                }
                for item in candidates
            ],
        }

    def _extract_with_raw(self, message: str) -> tuple[str, str, str, str, list[MemoryCandidate]]:
        system_prompt = _build_memory_system_prompt()
        response: Any = self._client.chat.completions.create(
            model=self._model_name,
            messages=[
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {"role": "user", "content": message},
            ],
            thinking={"type": "disabled"},
            max_tokens=2048,
            temperature=0.1,
        )

        raw_message = response.choices[0].message
        raw_response = _safe_serialize_response(response)
        text = _extract_message_text(raw_message)
        return system_prompt, message, raw_response, text, _parse_candidates(text)


class LangChainZhipuMemoryExtractor:
    """LangChain + Zhipu(OpenAI compatible) memory extractor."""

    def __init__(self, api_key: str, model_name: str) -> None:
        try:
            from langchain_openai import ChatOpenAI  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("langchain-openai is required for LangChainZhipuMemoryExtractor") from exc

        self._model_name = model_name
        self._llm = ChatOpenAI(
            model=model_name,
            temperature=0.1,
            model_kwargs={"max_tokens": 2048},
            api_key=SecretStr(api_key),
            base_url="https://open.bigmodel.cn/api/paas/v4/",
        )

    def extract(self, message: str) -> list[MemoryCandidate]:
        _, _, _, _, candidates = self._extract_with_raw(message)
        return candidates

    def extract_debug(self, message: str) -> dict[str, object]:
        system_prompt, user_content, raw_response, raw_text, candidates = self._extract_with_raw(message)
        return {
            "backend": "zhipu-langchain",
            "model": self._model_name,
            "is_llm": True,
            "system_prompt": system_prompt,
            "user_content": user_content,
            "raw_response": raw_response,
            "raw_text": raw_text,
            "candidates": [
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                    "confidence": item.confidence,
                    "importance": item.importance,
                }
                for item in candidates
            ],
        }

    def _extract_with_raw(self, message: str) -> tuple[str, str, str, str, list[MemoryCandidate]]:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("langchain-core is required for LangChainZhipuMemoryExtractor") from exc

        system_prompt = _build_memory_system_prompt()
        response = self._llm.invoke(
            [
                SystemMessage(content=system_prompt),
                HumanMessage(content=message),
            ],
        )
        raw_response = _safe_serialize_response(response)
        text = _extract_langchain_content(response)
        if not text and _is_length_truncated(response):
            text = "[]"
        return system_prompt, message, raw_response, text, _parse_candidates(text)


class MemoryService:
    """Memory pipeline with pluggable repository and vector backends."""

    def __init__(
        self,
        repository: MemoryRepository,
        vector_store: VectorStore,
        embedding_model: SimpleEmbeddingModel,
        extractor: MemoryExtractor,
        extraction_reason: str,
    ) -> None:
        self.repository = repository
        self.vector_store = vector_store
        self.embedding_model = embedding_model
        self.extractor = extractor
        self.extraction_reason = extraction_reason

    @staticmethod
    def build_from_env() -> "MemoryService":
        config = MemoryBackendConfig.from_env()

        repository: MemoryRepository
        vector_store: VectorStore

        if config.repository == "postgres":
            dsn = _get_env("POSTGRES_DSN", "")
            if not dsn:
                raise RuntimeError("POSTGRES_DSN is required when MEMORY_REPOSITORY=postgres")
            repository = PostgresMemoryRepository(dsn=dsn)
        else:
            repository = InMemoryMemoryRepository()

        if config.vector == "qdrant":
            qdrant_url = _get_env("QDRANT_URL", "http://localhost:6333")
            qdrant_collection = _get_env("QDRANT_COLLECTION", "companion_memory")
            vector_store = QdrantVectorStore(
                url=qdrant_url,
                collection_name=qdrant_collection,
                vector_size=16,
            )
        else:
            vector_store = InMemoryVectorStore()

        extractor: MemoryExtractor
        extraction_reason = "configured to use local rule extractor"
        if config.extraction_backend == "zhipu":
            api_key = _get_env("ZAI_API_KEY", _get_env("ZHIPU_API_KEY", ""))
            runtime = _get_env("MEMORY_EXTRACTION_RUNTIME", "langchain")
            if not api_key:
                extractor = RuleMemoryExtractor()
                extraction_reason = "fallback to rule: ZAI_API_KEY/ZHIPU_API_KEY missing"
            else:
                try:
                    if runtime == "langchain":
                        extractor = LangChainZhipuMemoryExtractor(
                            api_key=api_key,
                            model_name=config.extraction_model_name,
                        )
                        extraction_reason = f"using llm extractor(langchain): {config.extraction_model_name}"
                    else:
                        extractor = ZhipuMemoryExtractor(api_key=api_key, model_name=config.extraction_model_name)
                        extraction_reason = f"using llm extractor(zai): {config.extraction_model_name}"
                except Exception as exc:
                    extractor = RuleMemoryExtractor()
                    extraction_reason = f"fallback to rule: {exc}"
        else:
            extractor = RuleMemoryExtractor()
            extraction_reason = f"configured backend is {config.extraction_backend}"

        return MemoryService(
            repository=repository,
            vector_store=vector_store,
            embedding_model=SimpleEmbeddingModel(dim=16),
            extractor=extractor,
            extraction_reason=extraction_reason,
        )

    def extract_candidates(self, message: str) -> list[MemoryCandidate]:
        try:
            return self.extractor.extract(message)
        except Exception:
            return []

    def extract_candidates_from_turn(
        self,
        user_message: str,
        assistant_reply: str,
        agent_name: str,
        historical_memories: list[MemoryItem] | None = None,
    ) -> list[MemoryCandidate]:
        memory_lines: list[str] = []
        if historical_memories:
            for item in historical_memories[:8]:
                memory_lines.append(f"- ({item.subject}/{item.memory_type}) {item.content}")
        memory_text = "\n".join(memory_lines) if memory_lines else "- 无"

        dialogue_text = (
            f"你现在就是agent: {agent_name}。"
            "以下是你已经记住的历史记忆，请结合它们避免重复并判断是否需要新增记忆。\n"
            f"历史记忆:\n{memory_text}\n"
            "请判断这一轮对话中，是否有需要长期保存的记忆，并为每条记忆标注主语。\n"
            f"用户: {user_message}\n"
            f"{agent_name}: {assistant_reply}"
        )
        return self.extract_candidates(dialogue_text)

    def initialize_agent_profile_memories(self, profile: AgentProfile) -> list[MemoryItem]:
        existing = self.repository.list_by_user(user_id=AGENT_PROFILE_MEMORY_USER_ID, agent_id=profile.id)
        if existing:
            return existing

        seed_message = _build_agent_profile_seed_message(profile)
        candidates = self.extract_candidates(seed_message)
        identity_candidate = _build_agent_identity_candidate(profile)
        agent_candidates = [item for item in candidates if item.subject == "agent"]
        agent_candidates = [identity_candidate] + [
            item for item in agent_candidates if item.content != identity_candidate.content
        ]
        if len(agent_candidates) <= 1:
            fallback_candidates = _fallback_agent_profile_candidates(profile)
            agent_candidates = [identity_candidate] + [
                item for item in fallback_candidates if item.content != identity_candidate.content
            ]

        return self.persist_candidates(
            user_id=AGENT_PROFILE_MEMORY_USER_ID,
            agent_id=profile.id,
            candidates=agent_candidates,
        )

    def debug_agent_profile_memory_seed(
        self,
        profile: AgentProfile,
        dry_run: bool = True,
        force_reextract: bool = False,
    ) -> dict[str, object]:
        existing = self.repository.list_by_user(user_id=AGENT_PROFILE_MEMORY_USER_ID, agent_id=profile.id)
        skipped_existing = bool(existing) and not force_reextract and not dry_run

        extraction_debug: dict[str, object] = {}
        seed_message = _build_agent_profile_seed_message(profile)
        if not skipped_existing:
            extraction_debug = self.extract_candidates_debug(seed_message)

        raw_candidates = extraction_debug.get("candidates", []) if extraction_debug else []
        parsed_candidates: list[MemoryCandidate] = []
        if isinstance(raw_candidates, list):
            for row in raw_candidates:
                if not isinstance(row, dict):
                    continue
                memory_type = str(row.get("memory_type", "")).strip()
                content = str(row.get("content", "")).strip()
                if not memory_type or not content:
                    continue
                try:
                    confidence = float(row.get("confidence", 0.6))
                    importance = float(row.get("importance", 0.6))
                except (TypeError, ValueError):
                    confidence = 0.6
                    importance = 0.6

                parsed_candidates.append(
                    MemoryCandidate(
                        subject=_normalize_subject(str(row.get("subject", "user"))),
                        memory_type=memory_type,
                        content=content,
                        confidence=max(0.0, min(1.0, confidence)),
                        importance=max(0.0, min(1.0, importance)),
                    ),
                )

        identity_candidate = _build_agent_identity_candidate(profile)
        agent_candidates = [item for item in parsed_candidates if item.subject == "agent"]
        agent_candidates = [identity_candidate] + [
            item for item in agent_candidates if item.content != identity_candidate.content
        ]
        used_fallback = False
        if not skipped_existing and len(agent_candidates) <= 1:
            used_fallback = True
            fallback_candidates = _fallback_agent_profile_candidates(profile)
            agent_candidates = [identity_candidate] + [
                item for item in fallback_candidates if item.content != identity_candidate.content
            ]

        persisted: list[MemoryItem] = []
        if not dry_run and not skipped_existing:
            persisted = self.persist_candidates(
                user_id=AGENT_PROFILE_MEMORY_USER_ID,
                agent_id=profile.id,
                candidates=agent_candidates,
            )

        return {
            "dry_run": dry_run,
            "force_reextract": force_reextract,
            "skipped_existing": skipped_existing,
            "existing_count": len(existing),
            "seed_message": seed_message,
            "used_fallback": used_fallback,
            "candidate_count": len(agent_candidates),
            "persisted_count": len(persisted),
            "extraction_debug": extraction_debug,
            "candidates": [
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                    "confidence": item.confidence,
                    "importance": item.importance,
                }
                for item in agent_candidates
            ],
        }

    def extract_candidates_debug(self, message: str) -> dict[str, object]:
        try:
            debug = self.extractor.extract_debug(message)
            debug["reason"] = self.extraction_reason
            return debug
        except Exception as exc:
            return {
                "backend": "unknown",
                "model": "unknown",
                "is_llm": False,
                "raw_text": "",
                "reason": f"extractor error: {exc}",
                "candidates": [],
            }

    def persist_candidates(self, user_id: str, agent_id: str, candidates: list[MemoryCandidate]) -> list[MemoryItem]:
        persisted: list[MemoryItem] = []
        for candidate in candidates:
            item = MemoryItem(
                id=str(uuid4()),
                user_id=user_id,
                agent_id=agent_id,
                subject=_normalize_subject(candidate.subject),
                memory_type=candidate.memory_type,
                content=candidate.content,
                confidence=candidate.confidence,
                importance=candidate.importance,
                status="active",
                created_at=datetime.now(UTC),
            )
            saved = self.repository.add(item)
            self.vector_store.upsert(
                item_id=saved.id,
                vector=self.embedding_model.embed(saved.content),
                payload={
                    "user_id": saved.user_id,
                    "agent_id": saved.agent_id,
                    "memory_type": saved.memory_type,
                },
            )
            persisted.append(saved)
        return persisted

    def retrieve_relevant(
        self,
        user_id: str,
        agent_id: str,
        query_text: str | None = None,
        limit: int = 5,
    ) -> list[MemoryItem]:
        items = [item for item in self.repository.list_by_user(user_id, agent_id) if item.status == "active"]
        shared_items_all = [
            item
            for item in self.repository.list_by_user(AGENT_PROFILE_MEMORY_USER_ID, agent_id)
            if item.status == "active"
        ]
        if not items and not shared_items_all:
            return []

        # If vector search has hits, we prefer semantic recall and then fall back to importance sorting.
        retrieval_query = query_text.strip() if query_text else ""
        if not retrieval_query:
            base_items = items if items else shared_items_all
            retrieval_query = " ".join(item.content for item in base_items[-3:])

        query_vector = self.embedding_model.embed(retrieval_query)
        semantic_ids = self.vector_store.search(
            query_vector=query_vector,
            user_id=user_id,
            agent_id=agent_id,
            limit=limit,
        )
        shared_ids = self.vector_store.search(
            query_vector=query_vector,
            user_id=AGENT_PROFILE_MEMORY_USER_ID,
            agent_id=agent_id,
            limit=limit,
        )
        semantic_items = self.repository.get_by_ids(user_id=user_id, agent_id=agent_id, ids=semantic_ids)
        shared_items = self.repository.get_by_ids(
            user_id=AGENT_PROFILE_MEMORY_USER_ID,
            agent_id=agent_id,
            ids=shared_ids,
        )

        semantic_id_set = {item.id for item in semantic_items}
        remaining_items = [item for item in items if item.id not in semantic_id_set]
        ranked_shared = sorted(
            shared_items,
            key=lambda item: (item.importance, item.confidence, item.created_at.timestamp()),
            reverse=True,
        )

        ranked_remaining = sorted(
            remaining_items,
            key=lambda item: (item.importance, item.confidence, item.created_at.timestamp()),
            reverse=True,
        )
        combined = semantic_items + ranked_shared + ranked_remaining
        return combined[:limit]

    def list_memories(self, user_id: str, agent_id: str, status: str = "all") -> list[MemoryItem]:
        items = self.repository.list_by_user(user_id, agent_id)
        if status == "all":
            return items
        return [item for item in items if item.status == status]

    def freeze_memory(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        return self.repository.set_status(user_id=user_id, agent_id=agent_id, memory_id=memory_id, status="frozen")

    def activate_memory(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        return self.repository.set_status(user_id=user_id, agent_id=agent_id, memory_id=memory_id, status="active")

    def delete_memory(self, user_id: str, agent_id: str, memory_id: str) -> MemoryItem | None:
        return self.repository.set_status(user_id=user_id, agent_id=agent_id, memory_id=memory_id, status="deleted")


def _extract_message_text(raw_message: object) -> str:
    if hasattr(raw_message, "content"):
        content = getattr(raw_message, "content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            text_parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text_value = part.get("text")
                    if isinstance(text_value, str):
                        text_parts.append(text_value)
            return "\n".join(text_parts).strip()

    if isinstance(raw_message, dict):
        content = raw_message.get("content", "")
        if isinstance(content, str):
            return content.strip()

    return ""


def _parse_candidates(text: str) -> list[MemoryCandidate]:
    raw = text.strip()
    if not raw:
        return []

    # Handle fenced JSON like ```json ... ```
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()

    try:
        data = json.loads(raw)
    except Exception:
        return []

    if not isinstance(data, list):
        return []

    candidates: list[MemoryCandidate] = []
    for row in data[:8]:
        if not isinstance(row, dict):
            continue

        subject = _normalize_subject(str(row.get("subject", "user")))
        memory_type = str(row.get("memory_type", "")).strip()
        content = str(row.get("content", "")).strip()
        if not memory_type or not content:
            continue

        try:
            confidence = float(row.get("confidence", 0.6))
            importance = float(row.get("importance", 0.6))
        except (TypeError, ValueError):
            confidence = 0.6
            importance = 0.6

        candidates.append(
            MemoryCandidate(
                subject=subject,
                memory_type=memory_type,
                content=content,
                confidence=max(0.0, min(1.0, confidence)),
                importance=max(0.0, min(1.0, importance)),
            ),
        )

    return candidates


def _extract_langchain_content(response: object) -> str:
    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                text_value = part.get("text")
                if isinstance(text_value, str) and text_value.strip():
                    parts.append(text_value.strip())
            elif isinstance(part, str) and part.strip():
                parts.append(part.strip())
        return "\n".join(parts).strip()

    if isinstance(content, dict):
        text_value = content.get("text")
        if isinstance(text_value, str):
            return text_value.strip()

    return ""


def _is_length_truncated(response: object) -> bool:
    metadata = getattr(response, "response_metadata", None)
    if isinstance(metadata, dict):
        return str(metadata.get("finish_reason", "")).lower() == "length"
    return False


def _safe_serialize_response(response: object) -> str:
    try:
        if hasattr(response, "model_dump_json"):
            dump_json = getattr(response, "model_dump_json")
            if callable(dump_json):
                return str(dump_json())
        if hasattr(response, "model_dump"):
            dump_obj = getattr(response, "model_dump")
            if callable(dump_obj):
                return json.dumps(dump_obj(), ensure_ascii=False)
    except Exception:
        pass

    try:
        return json.dumps(response, ensure_ascii=False, default=str)
    except Exception:
        return str(response)


def _build_memory_system_prompt() -> str:
    return (
        "你正在以'当前agent本人'的视角判断记忆。"
        "请基于一轮对话片段判断，作为这个agent是否有需要长期记住的信息。"
        "若无长期价值信息，返回空数组[]。"
        "只输出JSON数组，每项格式: "
        "{\"subject\":\"user|agent\","
        "\"memory_type\":\"profile|preference|relationship|goal|emotional_pattern\","
        "\"content\":\"...\",\"confidence\":0-1,\"importance\":0-1}。"
        "其中subject=agent表示agent自己的长期设定或行为偏好，subject=user表示用户相关长期信息。"
        "最多返回8条。"
    )


def _normalize_subject(subject: str) -> str:
    value = subject.strip().lower()
    if value in {"agent", "assistant", "self", "我", "角色"}:
        return "agent"
    return "user"


def _build_agent_profile_seed_message(profile: AgentProfile) -> str:
    hobbies_text = "、".join(profile.hobbies) if profile.hobbies else "无"
    display_name = profile.display_name or profile.name
    return (
        "请基于以下AI角色设定，提取可长期保存的角色记忆。"
        "这些记忆都应属于角色自身，subject必须是agent。"
        "尽量详细，覆盖身份背景、价值观、边界、互动偏好、表达风格与稳定目标。\n"
        f"角色内部名: {profile.name}\n"
        f"对用户展示名: {display_name}\n"
        f"核心性格: {profile.persona}\n"
        f"背景: {profile.background}\n"
        f"爱好: {hobbies_text}\n"
        f"说话风格: {profile.speaking_style}\n"
    )


def _build_agent_identity_candidate(profile: AgentProfile) -> MemoryCandidate:
    display_name = profile.display_name or profile.name
    return MemoryCandidate(
        subject="agent",
        memory_type="profile",
        content=f"我的内部角色名是{profile.name}，对用户展示名是{display_name}。",
        confidence=1.0,
        importance=1.0,
    )


def _fallback_agent_profile_candidates(profile: AgentProfile) -> list[MemoryCandidate]:
    hobbies_text = "、".join(profile.hobbies) if profile.hobbies else "无特别爱好"
    return [
        MemoryCandidate(
            subject="agent",
            memory_type="profile",
            content=f"我是{profile.name}，核心性格是{profile.persona}。",
            confidence=0.95,
            importance=0.95,
        ),
        MemoryCandidate(
            subject="agent",
            memory_type="profile",
            content=f"我的背景设定是：{profile.background}。",
            confidence=0.93,
            importance=0.9,
        ),
        MemoryCandidate(
            subject="agent",
            memory_type="preference",
            content=f"我的兴趣偏好包括：{hobbies_text}。",
            confidence=0.88,
            importance=0.72,
        ),
        MemoryCandidate(
            subject="agent",
            memory_type="relationship",
            content="我会以陪伴者身份与用户长期互动，保持稳定、可信与一致的人设。",
            confidence=0.84,
            importance=0.8,
        ),
        MemoryCandidate(
            subject="agent",
            memory_type="emotional_pattern",
            content=f"我的表达风格应保持{profile.speaking_style}，在情绪支持场景中优先共情和温和回应。",
            confidence=0.86,
            importance=0.78,
        ),
        MemoryCandidate(
            subject="agent",
            memory_type="goal",
            content="我的长期目标是持续提供有帮助、稳定且尊重边界的陪伴式对话。",
            confidence=0.82,
            importance=0.76,
        ),
    ]


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
