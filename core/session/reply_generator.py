from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator
import json

from core.common.openrouter import OpenRouterError, get_env, get_openrouter_client
from core.session.conversation_store import ConversationTurn


class LLMUnavailableError(RuntimeError):
    pass


@dataclass
class GeneratedReply:
    reply: str
    mood_label: str
    mood_intensity: float
    heartbeat_bpm: int


class ReplyGenerator:
    """Final response generator powered by OpenRouter."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        try:
            self._client = get_openrouter_client("CHAT_MODEL_NAME", model_name)
        except OpenRouterError:
            self._client = None

    @staticmethod
    def build_from_env() -> "ReplyGenerator":
        model_name = get_env("CHAT_MODEL_NAME", "openai/gpt-5.2")
        return ReplyGenerator(model_name=model_name)

    def generate(
        self,
        user_message: str,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> GeneratedReply:
        if self._client is None:
            raise LLMUnavailableError("model client unavailable")

        messages = _build_messages(
            user_message=user_message,
            recalled_memories=recalled_memories,
            recent_turns=recent_turns,
            persona_prompt=persona_prompt,
        )

        try:
            text = self._client.chat_text(
                messages=messages,
                max_tokens=4096,
                temperature=0.6,
            )
        except OpenRouterError as exc:
            raise LLMUnavailableError("failed to call llm") from exc

        if not text:
            raise LLMUnavailableError("llm returned empty content")
        return _parse_generated_reply(text)

    def stream_generate(
        self,
        user_message: str,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> Iterator[str]:
        generated = self.generate(
            user_message=user_message,
            recalled_memories=recalled_memories,
            recent_turns=recent_turns,
            persona_prompt=persona_prompt,
        )
        text = generated.reply
        if not text:
            raise LLMUnavailableError("llm returned empty content")
        chunk_size = 24
        for index in range(0, len(text), chunk_size):
            yield text[index : index + chunk_size]


def _build_messages(
    user_message: str,
    recalled_memories: list[dict[str, str]],
    recent_turns: list[ConversationTurn],
    persona_prompt: str | None,
) -> list[dict[str, str]]:
    memory_lines = [
        f"- ({item.get('subject', 'user')}/{item.get('memory_type', 'unknown')}) {item.get('content', '')}"
        for item in recalled_memories[:5]
    ]
    memory_text = "\n".join(memory_lines) if memory_lines else "- 无"

    history_lines: list[str] = []
    for turn in recent_turns:
        role = "用户" if turn.role == "user" else "assistant"
        history_lines.append(f"{role}: {turn.content}")
    history_text = "\n".join(history_lines) if history_lines else "无"

    system_prompt = (
        "你是一个有独特身份、性格、过去的真实个体。"
        "你需要做出符合你性格的回复，并且需要真实地带入情绪。"
        "你必须输出JSON对象，不要输出任何额外文字。"
    )

    if persona_prompt:
        system_prompt = system_prompt + "\n" + persona_prompt

    system_prompt = (
        system_prompt
        + "\n当前你拥有的长期记忆(格式: subject/memory_type):\n"
        + "其中subject=user表示用户相关记忆，subject=agent表示你自己的角色设定记忆。\n"
        + memory_text
    )

    user_prompt = (
        "请基于以下结构化上下文生成最终回复，并同时给出你(Agent视角)此刻心情参数。\n"
        f"最近多轮历史:\n{history_text}\n"
        f"用户当前输入: {user_message}\n"
        "请严格输出JSON，格式如下:"
        '{"reply":"2-5句自然中文","agent_mood":{"label":"calm|happy|sad|anxious|angry|focused","intensity":0-1,"heartbeat_bpm":55-130} }'
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def _parse_generated_reply(raw_text: str) -> GeneratedReply:
    normalized = _strip_fenced_json(raw_text)
    try:
        payload = json.loads(normalized)
    except Exception as exc:
        raise LLMUnavailableError("llm returned non-json content") from exc

    if not isinstance(payload, dict):
        raise LLMUnavailableError("llm json payload is invalid")

    reply = str(payload.get("reply", "")).strip()
    mood_obj = payload.get("agent_mood", {})
    if not isinstance(mood_obj, dict):
        mood_obj = {}

    mood_label = str(mood_obj.get("label", "calm")).strip().lower() or "calm"
    try:
        mood_intensity = float(mood_obj.get("intensity", 0.35))
    except (TypeError, ValueError):
        mood_intensity = 0.35
    mood_intensity = max(0.0, min(1.0, mood_intensity))

    try:
        heartbeat_bpm = int(float(mood_obj.get("heartbeat_bpm", 72)))
    except (TypeError, ValueError):
        heartbeat_bpm = 72
    heartbeat_bpm = max(55, min(130, heartbeat_bpm))

    if not reply:
        raise LLMUnavailableError("llm returned empty reply in json")

    return GeneratedReply(
        reply=reply,
        mood_label=mood_label,
        mood_intensity=mood_intensity,
        heartbeat_bpm=heartbeat_bpm,
    )


def _strip_fenced_json(raw_text: str) -> str:
    text = raw_text.strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()
