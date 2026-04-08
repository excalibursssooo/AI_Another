from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from core.agents.models import AgentProfile
from core.common.openrouter import OpenRouterError, get_openrouter_client
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
            extraction_backend=_get_env("MEMORY_EXTRACTION_BACKEND", "openrouter"),
            extraction_model_name=_get_env("MEMORY_EXTRACTION_MODEL_NAME", "openai/gpt-5.2"),
        )


@dataclass
class RetrievalScoreWeights:
    semantic: float = 0.35
    importance: float = 0.22
    freshness: float = 0.18
    stability: float = 0.17
    conflict: float = 0.08

    def normalized(self) -> "RetrievalScoreWeights":
        total = self.semantic + self.importance + self.freshness + self.stability + self.conflict
        if total <= 0:
            return RetrievalScoreWeights()
        return RetrievalScoreWeights(
            semantic=self.semantic / total,
            importance=self.importance / total,
            freshness=self.freshness / total,
            stability=self.stability / total,
            conflict=self.conflict / total,
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
                    memory_type="relationship_tendency",
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

        if any(token in message for token in ["难过", "焦虑", "生气", "开心", "情绪", "崩溃", "压力"]):
            candidates.append(
                MemoryCandidate(
                    subject="user",
                    memory_type="emotional_tendency",
                    content=message,
                    confidence=0.68,
                    importance=0.74,
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


class OpenRouterMemoryExtractor:
    """LLM-based extractor using OpenRouter."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        self._client = get_openrouter_client("MEMORY_EXTRACTION_MODEL_NAME", model_name)

    def extract(self, message: str) -> list[MemoryCandidate]:
        _, _, _, _, candidates = self._extract_with_raw(message)
        return candidates

    def extract_debug(self, message: str) -> dict[str, object]:
        system_prompt, user_content, raw_response, raw_text, candidates = self._extract_with_raw(message)
        return {
            "backend": "openrouter",
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
        payload = self._client.chat_json(
            messages=[
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {"role": "user", "content": message},
            ],
            max_tokens=2048,
            temperature=0.1,
        )
        raw_response = _safe_serialize_response(payload)
        text = _extract_openrouter_content(payload)
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
        self._retrieval_weights = RetrievalScoreWeights()

    def get_retrieval_weights(self) -> RetrievalScoreWeights:
        return self._retrieval_weights

    def update_retrieval_weights(
        self,
        *,
        semantic: float,
        importance: float,
        freshness: float,
        stability: float,
        conflict: float,
    ) -> RetrievalScoreWeights:
        candidate = RetrievalScoreWeights(
            semantic=max(0.0, semantic),
            importance=max(0.0, importance),
            freshness=max(0.0, freshness),
            stability=max(0.0, stability),
            conflict=max(0.0, conflict),
        ).normalized()
        self._retrieval_weights = candidate
        return candidate

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
        if config.extraction_backend == "openrouter":
            api_key = _get_env("OPENROUTER_API_KEY", "")
            if not api_key:
                extractor = RuleMemoryExtractor()
                extraction_reason = "fallback to rule: OPENROUTER_API_KEY missing"
            else:
                try:
                    extractor = OpenRouterMemoryExtractor(model_name=config.extraction_model_name)
                    extraction_reason = f"using llm extractor(openrouter): {config.extraction_model_name}"
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
        existing_items = [
            item
            for item in self.repository.list_by_user(user_id=user_id, agent_id=agent_id)
            if item.status != "deleted"
        ]

        for candidate in candidates:
            normalized_subject = _normalize_subject(candidate.subject)
            normalized_memory_type = _normalize_memory_type(candidate.memory_type)
            normalized_content = _normalize_memory_content(candidate.content)
            if not normalized_content:
                continue

            matched, matched_score = _find_best_related_memory(
                existing_items=existing_items,
                subject=normalized_subject,
                memory_type=normalized_memory_type,
                normalized_content=normalized_content,
            )
            if matched is not None and matched_score >= 0.88:
                self.repository.touch(user_id=user_id, agent_id=agent_id, memory_ids=[matched.id])
                continue

            if matched is not None and matched_score >= 0.62 and _is_conflict_content(
                old_text=matched.content,
                new_text=candidate.content,
            ):
                updated = self.repository.replace(
                    user_id=user_id,
                    agent_id=agent_id,
                    memory_id=matched.id,
                    content=candidate.content.strip(),
                    confidence=candidate.confidence,
                    importance=candidate.importance,
                    status="active",
                    conflict_state="resolved_conflict",
                )
                if updated is not None:
                    self.vector_store.upsert(
                        item_id=updated.id,
                        vector=self.embedding_model.embed(updated.content),
                        payload={
                            "user_id": updated.user_id,
                            "agent_id": updated.agent_id,
                            "memory_type": updated.memory_type,
                        },
                    )
                    existing_items = [updated if item.id == updated.id else item for item in existing_items]
                continue

            if matched is not None and matched_score >= 0.62:
                merged_confidence = max(matched.confidence, candidate.confidence)
                merged_importance = max(matched.importance, candidate.importance)
                replacement_content = matched.content
                if len(candidate.content.strip()) > len(matched.content.strip()):
                    replacement_content = candidate.content.strip()

                updated = self.repository.replace(
                    user_id=user_id,
                    agent_id=agent_id,
                    memory_id=matched.id,
                    content=replacement_content,
                    confidence=merged_confidence,
                    importance=merged_importance,
                    status="active",
                    conflict_state="none",
                )
                if updated is not None:
                    self.vector_store.upsert(
                        item_id=updated.id,
                        vector=self.embedding_model.embed(updated.content),
                        payload={
                            "user_id": updated.user_id,
                            "agent_id": updated.agent_id,
                            "memory_type": updated.memory_type,
                        },
                    )
                    existing_items = [updated if item.id == updated.id else item for item in existing_items]
                continue

            item = MemoryItem(
                id=str(uuid4()),
                user_id=user_id,
                agent_id=agent_id,
                subject=normalized_subject,
                memory_type=normalized_memory_type,
                content=candidate.content.strip(),
                confidence=candidate.confidence,
                importance=candidate.importance,
                status="active",
                conflict_state="none",
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
            existing_items.append(saved)
        return persisted

    def retrieve_relevant(
        self,
        user_id: str,
        agent_id: str,
        query_text: str | None = None,
        limit: int = 5,
    ) -> list[MemoryItem]:
        scored_entries = self.debug_retrieval_scores(
            user_id=user_id,
            agent_id=agent_id,
            query_text=query_text,
            limit=limit,
        )
        selected = [entry["memory"] for entry in scored_entries if isinstance(entry.get("memory"), MemoryItem)]
        if not selected:
            return []

        user_ids = [item.id for item in selected if item.user_id == user_id]
        shared_profile_ids = [item.id for item in selected if item.user_id == AGENT_PROFILE_MEMORY_USER_ID]
        self.repository.touch(user_id=user_id, agent_id=agent_id, memory_ids=user_ids)
        self.repository.touch(
            user_id=AGENT_PROFILE_MEMORY_USER_ID,
            agent_id=agent_id,
            memory_ids=shared_profile_ids,
        )
        return selected

    def debug_retrieval_scores(
        self,
        user_id: str,
        agent_id: str,
        query_text: str | None = None,
        limit: int = 5,
    ) -> list[dict[str, object]]:
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

        semantic_score_map = _build_semantic_score_map(semantic_ids + shared_ids)
        semantic_id_set = set(semantic_score_map.keys())
        remaining_items = [item for item in items if item.id not in semantic_id_set]
        now = datetime.now(UTC)

        unique_candidates: dict[str, MemoryItem] = {}
        for item in semantic_items + shared_items + remaining_items:
            unique_candidates[item.id] = item

        ranked_all = sorted(
            unique_candidates.values(),
            key=lambda item: (
                _composite_retrieval_score(
                    item=item,
                    now=now,
                    semantic_score=semantic_score_map.get(item.id, 0.0),
                    weights=self._retrieval_weights,
                ),
                item.created_at.timestamp(),
            ),
            reverse=True,
        )

        scored: list[dict[str, object]] = []
        for rank, item in enumerate(ranked_all[:limit], start=1):
            semantic_score = semantic_score_map.get(item.id, 0.0)
            freshness_score = _freshness_score(item, now)
            stability_score = _stability_score(item)
            conflict_factor = _conflict_factor(item)
            importance_score = max(0.0, min(1.0, item.importance))
            final_score = _composite_retrieval_score(
                item=item,
                now=now,
                semantic_score=semantic_score,
                weights=self._retrieval_weights,
            )
            scored.append(
                {
                    "rank": rank,
                    "memory": item,
                    "semantic_score": semantic_score,
                    "importance_score": importance_score,
                    "freshness_score": freshness_score,
                    "stability_score": stability_score,
                    "conflict_factor": conflict_factor,
                    "final_score": final_score,
                },
            )

        return scored

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

    def compact_similar_memories(self, user_id: str, agent_id: str) -> dict[str, object]:
        items = [item for item in self.repository.list_by_user(user_id, agent_id) if item.status == "active"]
        if len(items) <= 1:
            return {
                "total": len(items),
                "deleted_count": 0,
                "deleted_ids": [],
            }

        groups: dict[tuple[str, str], list[MemoryItem]] = {}
        for item in items:
            key = (item.subject, item.memory_type)
            if key not in groups:
                groups[key] = []
            groups[key].append(item)

        deleted_ids: list[str] = []
        now = datetime.now(UTC)

        for group_items in groups.values():
            if len(group_items) <= 1:
                continue

            ordered = sorted(
                group_items,
                key=lambda item: (_metabolism_score(item, now), item.created_at.timestamp()),
                reverse=True,
            )
            kept: list[MemoryItem] = []
            for item in ordered:
                normalized_content = _normalize_memory_content(item.content)
                is_duplicate = any(
                    _content_similarity(normalized_content, _normalize_memory_content(existing.content)) >= 0.88
                    for existing in kept
                )
                if is_duplicate:
                    updated = self.repository.set_status(
                        user_id=user_id,
                        agent_id=agent_id,
                        memory_id=item.id,
                        status="deleted",
                    )
                    if updated is not None:
                        deleted_ids.append(item.id)
                    continue

                kept.append(item)

        return {
            "total": len(items),
            "deleted_count": len(deleted_ids),
            "deleted_ids": deleted_ids,
        }


def _extract_openrouter_content(payload: dict[str, object]) -> str:
    choices_obj = payload.get("choices")
    if not isinstance(choices_obj, list) or not choices_obj:
        return ""

    first = choices_obj[0]
    if not isinstance(first, dict):
        return ""

    message_obj = first.get("message")
    if not isinstance(message_obj, dict):
        return ""

    content = message_obj.get("content")
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
        "\"memory_type\":\"profile|preference|relationship|goal|relationship_tendency|emotional_tendency\","
        "\"content\":\"...\",\"confidence\":0-1,\"importance\":0-1}。"
        "其中subject=agent表示agent自己的长期设定或行为偏好，subject=user表示用户相关长期信息。"
        "最多返回8条。"
    )


def _normalize_subject(subject: str) -> str:
    value = subject.strip().lower()
    if value in {"agent", "assistant", "self", "我", "角色"}:
        return "agent"
    return "user"


def _normalize_memory_type(memory_type: str) -> str:
    value = memory_type.strip().lower()
    mapping = {
        "emotion": "emotional_tendency",
        "emotional_pattern": "emotional_tendency",
        "emotion_pattern": "emotional_tendency",
        "relationship": "relationship_tendency",
    }
    if value in mapping:
        return mapping[value]

    allowed = {
        "profile",
        "preference",
        "goal",
        "relationship_tendency",
        "emotional_tendency",
    }
    if value in allowed:
        return value
    return "profile"


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


def _metabolism_score(item: MemoryItem, now: datetime) -> float:
    base_score = 0.6 * item.importance + 0.4 * item.confidence
    reference_time = item.last_accessed_at or item.created_at
    normalized_reference = _normalize_utc_datetime(reference_time)
    stale_hours = max((now - normalized_reference).total_seconds() / 3600.0, 0.0)

    # Half-life decay keeps old but still-relevant memories from dominating forever.
    half_life_hours = 72.0
    decay = 0.5 ** (stale_hours / half_life_hours)
    access_boost = min(0.25, 0.03 * float(item.access_count))
    return base_score * decay + access_boost


def _stability_score(item: MemoryItem) -> float:
    access_term = min(1.0, float(item.access_count) / 8.0)
    confidence_term = max(0.0, min(1.0, item.confidence))
    return 0.6 * access_term + 0.4 * confidence_term


def _freshness_score(item: MemoryItem, now: datetime) -> float:
    reference_time = item.last_accessed_at or item.created_at
    normalized_reference = _normalize_utc_datetime(reference_time)
    stale_hours = max((now - normalized_reference).total_seconds() / 3600.0, 0.0)
    half_life_hours = 72.0
    return 0.5 ** (stale_hours / half_life_hours)


def _conflict_factor(item: MemoryItem) -> float:
    if item.conflict_state == "resolved_conflict":
        return 0.6
    if item.conflict_state == "conflicted":
        return 0.45
    return 1.0


def _composite_retrieval_score(
    item: MemoryItem,
    now: datetime,
    semantic_score: float,
    *,
    weights: RetrievalScoreWeights,
) -> float:
    importance_term = max(0.0, min(1.0, item.importance))
    freshness_term = _freshness_score(item, now)
    stability_term = _stability_score(item)
    conflict_term = _conflict_factor(item)
    return (
        weights.semantic * semantic_score
        + weights.importance * importance_term
        + weights.freshness * freshness_term
        + weights.stability * stability_term
        + weights.conflict * conflict_term
    )


def _normalize_utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _normalize_memory_content(content: str) -> str:
    return " ".join(content.strip().lower().split())


def _build_semantic_score_map(ordered_ids: list[str]) -> dict[str, float]:
    if not ordered_ids:
        return {}
    score_map: dict[str, float] = {}
    denominator = float(len(ordered_ids) + 1)
    for index, memory_id in enumerate(ordered_ids):
        if memory_id in score_map:
            continue
        score_map[memory_id] = max(0.0, 1.0 - (float(index) / denominator))
    return score_map


def _find_best_related_memory(
    existing_items: list[MemoryItem],
    subject: str,
    memory_type: str,
    normalized_content: str,
) -> tuple[MemoryItem | None, float]:
    best_item: MemoryItem | None = None
    best_score = 0.0

    for item in existing_items:
        if item.subject != subject:
            continue
        if item.memory_type != memory_type:
            continue
        if item.status == "deleted":
            continue

        existing_content = _normalize_memory_content(item.content)
        score = _content_similarity(normalized_content, existing_content)
        if score > best_score:
            best_score = score
            best_item = item

    return best_item, best_score


def _content_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) >= 6 and shorter in longer:
        return 0.93

    return float(SequenceMatcher(None, a, b).ratio())


def _is_conflict_content(old_text: str, new_text: str) -> bool:
    old_norm = _normalize_memory_content(old_text)
    new_norm = _normalize_memory_content(new_text)
    if not old_norm or not new_norm:
        return False

    negative_tokens = ["不喜欢", "不是", "不会", "不要", "拒绝", "反感", "讨厌", "never", "dislike", "dont"]
    old_negative = any(token in old_norm for token in negative_tokens)
    new_negative = any(token in new_norm for token in negative_tokens)
    if old_negative == new_negative:
        return False

    return _content_similarity(old_norm, new_norm) >= 0.55
