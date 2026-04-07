from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterator, Protocol

from core.agents.models import AgentProfile
from core.memory.service import MemoryService
from core.safety.service import SafetyService
from core.session.conversation_store import ConversationStore, ConversationTurn
from core.session.reply_generator import GeneratedReply, LLMUnavailableError


class ReplyGeneratorLike(Protocol):
    def generate(
        self,
        user_message: str,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> GeneratedReply:
        ...

    def stream_generate(
        self,
        user_message: str,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> Iterator[str]:
        ...


@dataclass
class ChatResult:
    reply: str
    emotion_label: str
    mood_intensity: float
    heartbeat_bpm: int
    risk_level: str
    recalled_memories: list[dict[str, str]]
    persisted_memory_count: int
    agent_id: str
    agent_name: str


class SessionOrchestrator:
    """Coordinates safety, emotion, memory and response generation."""

    def __init__(
        self,
        memory_service: MemoryService,
        safety_service: SafetyService,
        reply_generator: ReplyGeneratorLike,
        conversation_store: ConversationStore,
    ) -> None:
        self.memory_service = memory_service
        self.safety_service = safety_service
        self.reply_generator = reply_generator
        self.conversation_store = conversation_store

    def handle_message(
        self,
        user_id: str,
        message: str,
        conversation_id: str,
        agent_profile: AgentProfile | None = None,
    ) -> ChatResult:
        target_agent_id = agent_profile.id if agent_profile is not None else "default"
        target_agent_name = agent_profile.name if agent_profile is not None else "小伴"
        target_agent_display_name = (
            agent_profile.display_name if agent_profile is not None and agent_profile.display_name else target_agent_name
        )
        conversation_key = f"{user_id}:{conversation_id}"

        safety_result = self.safety_service.check_risk(message)
        if safety_result.blocked:
            return ChatResult(
                reply=safety_result.guidance or "我在这里。",
                emotion_label="high_risk",
                mood_intensity=1.0,
                heartbeat_bpm=108,
                risk_level=safety_result.level,
                recalled_memories=[],
                persisted_memory_count=0,
                agent_id=target_agent_id,
                agent_name=target_agent_display_name,
            )

        recent_turns = self.conversation_store.recent(user_id=conversation_key, limit=8)
        recent_summary = _build_recent_turns_summary(recent_turns)
        retrieval_query = f"用户当前输入: {message}\n最近轮次摘要: {recent_summary}"
        recalled = self.memory_service.retrieve_relevant(
            user_id=user_id,
            agent_id=target_agent_id,
            query_text=retrieval_query,
            limit=5,
        )

        try:
            generated = self.reply_generator.generate(
                user_message=message,
                recalled_memories=[
                    {
                        "subject": item.subject,
                        "memory_type": item.memory_type,
                        "content": item.content,
                    }
                    for item in recalled
                ],
                recent_turns=recent_turns,
                persona_prompt=agent_profile.to_persona_prompt() if agent_profile is not None else None,
            )
            reply = generated.reply
        except LLMUnavailableError:
            reply = "当前无法调用大模型，请稍后再试。"
            generated = GeneratedReply(
                reply=reply,
                mood_label="neutral",
                mood_intensity=0.2,
                heartbeat_bpm=72,
            )

        self.conversation_store.append(user_id=conversation_key, role="user", content=message)
        self.conversation_store.append(user_id=conversation_key, role="assistant", content=reply)

        # Update memory only after a full user-agent round is completed.
        turn_candidates = self.memory_service.extract_candidates_from_turn(
            user_message=message,
            assistant_reply=reply,
            agent_name=target_agent_name,
            historical_memories=recalled,
        )
        persisted = self.memory_service.persist_candidates(
            user_id=user_id,
            agent_id=target_agent_id,
            candidates=turn_candidates,
        )

        return ChatResult(
            reply=reply,
            emotion_label=generated.mood_label,
            mood_intensity=generated.mood_intensity,
            heartbeat_bpm=generated.heartbeat_bpm,
            risk_level=safety_result.level,
            recalled_memories=[
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                }
                for item in recalled
            ],
            persisted_memory_count=len(persisted),
            agent_id=target_agent_id,
            agent_name=target_agent_display_name,
        )

    def stream_handle_message(
        self,
        user_id: str,
        message: str,
        conversation_id: str,
        agent_profile: AgentProfile | None = None,
    ) -> Iterator[dict[str, object]]:
        target_agent_id = agent_profile.id if agent_profile is not None else "default"
        target_agent_name = agent_profile.name if agent_profile is not None else "小伴"
        target_agent_display_name = (
            agent_profile.display_name if agent_profile is not None and agent_profile.display_name else target_agent_name
        )
        conversation_key = f"{user_id}:{conversation_id}"

        safety_result = self.safety_service.check_risk(message)
        if safety_result.blocked:
            guidance = safety_result.guidance or "我在这里。"
            yield {"type": "delta", "content": guidance}
            yield {
                "type": "done",
                "agent_id": target_agent_id,
                "agent_name": target_agent_display_name,
                "emotion_label": "high_risk",
                "mood_intensity": 1.0,
                "heartbeat_bpm": 108,
                "risk_level": safety_result.level,
                "recalled_memories": [],
                "persisted_memory_count": 0,
            }
            return

        recent_turns = self.conversation_store.recent(user_id=conversation_key, limit=8)
        recent_summary = _build_recent_turns_summary(recent_turns)
        retrieval_query = f"用户当前输入: {message}\n最近轮次摘要: {recent_summary}"
        recalled = self.memory_service.retrieve_relevant(
            user_id=user_id,
            agent_id=target_agent_id,
            query_text=retrieval_query,
            limit=5,
        )

        try:
            generated = self.reply_generator.generate(
                user_message=message,
                recalled_memories=[
                    {
                        "subject": item.subject,
                        "memory_type": item.memory_type,
                        "content": item.content,
                    }
                    for item in recalled
                ],
                recent_turns=recent_turns,
                persona_prompt=agent_profile.to_persona_prompt() if agent_profile is not None else None,
            )
            for piece in _chunk_text(generated.reply):
                yield {"type": "delta", "content": piece}
            reply = generated.reply
            if not reply:
                raise LLMUnavailableError("empty streamed reply")
        except LLMUnavailableError:
            reply = "当前无法调用大模型，请稍后再试。"
            generated = GeneratedReply(
                reply=reply,
                mood_label="neutral",
                mood_intensity=0.2,
                heartbeat_bpm=72,
            )
            yield {"type": "delta", "content": reply}

        self.conversation_store.append(user_id=conversation_key, role="user", content=message)
        self.conversation_store.append(user_id=conversation_key, role="assistant", content=reply)

        turn_candidates = self.memory_service.extract_candidates_from_turn(
            user_message=message,
            assistant_reply=reply,
            agent_name=target_agent_name,
            historical_memories=recalled,
        )
        persisted = self.memory_service.persist_candidates(
            user_id=user_id,
            agent_id=target_agent_id,
            candidates=turn_candidates,
        )

        yield {
            "type": "done",
            "agent_id": target_agent_id,
            "agent_name": target_agent_display_name,
            "emotion_label": generated.mood_label,
            "mood_intensity": generated.mood_intensity,
            "heartbeat_bpm": generated.heartbeat_bpm,
            "risk_level": safety_result.level,
            "recalled_memories": [
                {
                    "subject": item.subject,
                    "memory_type": item.memory_type,
                    "content": item.content,
                }
                for item in recalled
            ],
            "persisted_memory_count": len(persisted),
        }

    @staticmethod
    def to_dict(result: ChatResult) -> dict[str, object]:
        return asdict(result)


def _build_recent_turns_summary(recent_turns: list[ConversationTurn], max_turns: int = 4) -> str:
    if not recent_turns:
        return "无"

    lines: list[str] = []
    for turn in recent_turns[-max_turns:]:
        role = "用户" if turn.role == "user" else "助手"
        lines.append(f"{role}:{turn.content}")
    return " | ".join(lines)


def _chunk_text(content: str, chunk_size: int = 24) -> Iterator[str]:
    text = content.strip()
    if not text:
        return
    for index in range(0, len(text), chunk_size):
        yield text[index : index + chunk_size]
