from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterator

from pydantic import SecretStr

from core.session.conversation_store import ConversationTurn


class LLMUnavailableError(RuntimeError):
    pass


class ReplyGenerator:
    """Two-layer final response generator powered by Zhipu."""

    def __init__(self, api_key: str | None, model_name: str, runtime: str) -> None:
        self._api_key = api_key
        self._model_name = model_name
        self._runtime = runtime
        self._client: Any | None = None
        self._llm: Any | None = None

        if not api_key:
            return

        if runtime == "langchain":
            try:
                from langchain_openai import ChatOpenAI  # type: ignore
            except Exception as exc:  # pragma: no cover
                raise RuntimeError("langchain-openai is required for ReplyGenerator") from exc

            self._llm = ChatOpenAI(
                model=model_name,
                temperature=0.6,
                model_kwargs={"max_tokens": 4096},
                api_key=SecretStr(api_key),
                base_url="https://open.bigmodel.cn/api/paas/v4/",
            )
            return

        try:
            from zai import ZhipuAiClient  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("zai-sdk is required for ReplyGenerator") from exc

        self._client = ZhipuAiClient(api_key=api_key)

    @staticmethod
    def build_from_env() -> "ReplyGenerator":
        api_key = _get_env("ZAI_API_KEY", _get_env("ZHIPU_API_KEY", ""))
        model_name = _get_env("CHAT_MODEL_NAME", _get_env("EMOTION_MODEL_NAME", "glm-4.7-flash"))
        runtime = _get_env("CHAT_RUNTIME", "langchain")
        return ReplyGenerator(api_key=api_key or None, model_name=model_name, runtime=runtime)

    def generate(
        self,
        user_message: str,
        emotion_label: str,
        emotion_intensity: float,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> str:
        messages = _build_messages(
            user_message=user_message,
            emotion_label=emotion_label,
            emotion_intensity=emotion_intensity,
            recalled_memories=recalled_memories,
            recent_turns=recent_turns,
            persona_prompt=persona_prompt,
        )

        if self._runtime == "langchain":
            if self._llm is None:
                raise LLMUnavailableError("model client unavailable")
            return self._generate_with_langchain(messages)

        if self._client is None:
            raise LLMUnavailableError("model client unavailable")

        try:
            response: Any = self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
                thinking={"type": "disabled"},
                max_tokens=4096,
                temperature=0.6,
            )
        except Exception as exc:
            raise LLMUnavailableError("failed to call llm") from exc

        raw_message = response.choices[0].message
        text = _extract_message_text(raw_message)
        if not text:
            raise LLMUnavailableError("llm returned empty content")
        return text

    def stream_generate(
        self,
        user_message: str,
        emotion_label: str,
        emotion_intensity: float,
        recalled_memories: list[dict[str, str]],
        recent_turns: list[ConversationTurn],
        persona_prompt: str | None = None,
    ) -> Iterator[str]:
        messages = _build_messages(
            user_message=user_message,
            emotion_label=emotion_label,
            emotion_intensity=emotion_intensity,
            recalled_memories=recalled_memories,
            recent_turns=recent_turns,
            persona_prompt=persona_prompt,
        )

        if self._runtime == "langchain":
            if self._llm is None:
                raise LLMUnavailableError("model client unavailable")
            yield from self._stream_with_langchain(messages)
            return

        if self._client is None:
            raise LLMUnavailableError("model client unavailable")

        try:
            stream: Any = self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
                thinking={"type": "disabled"},
                stream=True,
                max_tokens=4096,
                temperature=0.6,
            )
        except Exception as exc:
            raise LLMUnavailableError("failed to call llm in stream mode") from exc

        yielded = False
        try:
            for chunk in stream:
                text_piece = _extract_stream_chunk_text(chunk)
                if not text_piece:
                    continue
                yielded = True
                yield text_piece
        except Exception as exc:
            raise LLMUnavailableError("failed during stream consumption") from exc

        if not yielded:
            raise LLMUnavailableError("llm stream returned empty content")

    def _generate_with_langchain(self, messages: list[dict[str, str]]) -> str:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise LLMUnavailableError("langchain-core unavailable") from exc

        try:
            llm = self._llm
            if llm is None:
                raise LLMUnavailableError("model client unavailable")
            response = llm.invoke(
                [
                    SystemMessage(content=messages[0]["content"]),
                    HumanMessage(content=messages[1]["content"]),
                ],
            )
        except Exception as exc:
            raise LLMUnavailableError("failed to call llm") from exc

        text = _extract_langchain_content(response)
        if not text:
            raise LLMUnavailableError("llm returned empty content")
        return text

    def _stream_with_langchain(self, messages: list[dict[str, str]]) -> Iterator[str]:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise LLMUnavailableError("langchain-core unavailable") from exc

        try:
            llm = self._llm
            if llm is None:
                raise LLMUnavailableError("model client unavailable")
            stream = llm.stream(
                [
                    SystemMessage(content=messages[0]["content"]),
                    HumanMessage(content=messages[1]["content"]),
                ],
            )
        except Exception as exc:
            raise LLMUnavailableError("failed to call llm in stream mode") from exc

        yielded = False
        try:
            for chunk in stream:
                text_piece = _extract_stream_chunk_text(chunk)
                if not text_piece:
                    continue
                yielded = True
                yield text_piece
        except Exception as exc:
            raise LLMUnavailableError("failed during stream consumption") from exc

        if not yielded:
            raise LLMUnavailableError("llm stream returned empty content")


def _build_messages(
    user_message: str,
    emotion_label: str,
    emotion_intensity: float,
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
        role = "用户" if turn.role == "user" else "助手"
        history_lines.append(f"{role}: {turn.content}")
    history_text = "\n".join(history_lines) if history_lines else "无"

    system_prompt = (
        "你是一个有独特身份、性格、过去的真实的个体。"
        "你需要做出符合你性格的回复，并且需要真实的带入情绪。"
    )

    if persona_prompt:
        system_prompt = system_prompt + "\n" + persona_prompt

    # Keep current recalled memories in system context so the agent can reason consistently.
    system_prompt = (
        system_prompt
        + "\n当前你拥有的长期记忆(格式: subject/memory_type):\n"
        + "其中subject=user表示用户相关记忆，subject=agent表示你自己的角色设定记忆。\n"
        + memory_text
    )

    user_prompt = (
        "请基于以下结构化上下文生成最终回复：\n"
        f"情绪标签: {emotion_label}\n"
        f"情绪强度: {emotion_intensity:.2f}\n"
        f"最近多轮历史:\n{history_text}\n"
        f"用户当前输入: {user_message}\n"
        "请输出自然中文回复，2-5句。"
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def _extract_message_text(raw_message: object) -> str:
    if hasattr(raw_message, "content"):
        content = getattr(raw_message, "content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            return "\n".join(parts).strip()

    if isinstance(raw_message, dict):
        content = raw_message.get("content")
        if isinstance(content, str):
            return content.strip()

    return ""


def _extract_langchain_content(raw_message: object) -> str:
    if hasattr(raw_message, "content"):
        content = getattr(raw_message, "content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                elif isinstance(part, str):
                    parts.append(part)
            return "\n".join(parts).strip()

    return ""


def _extract_stream_chunk_text(chunk: object) -> str:
    if hasattr(chunk, "content"):
        content = getattr(chunk, "content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                elif isinstance(part, str):
                    parts.append(part)
            return "".join(parts)

    # Compatible with OpenAI-like delta chunks and plain dict payloads.
    if hasattr(chunk, "choices"):
        choices = getattr(chunk, "choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if hasattr(first, "delta"):
                delta = getattr(first, "delta")
                if hasattr(delta, "content"):
                    content = getattr(delta, "content")
                    if isinstance(content, str):
                        return content
                if isinstance(delta, dict):
                    content = delta.get("content")
                    if isinstance(content, str):
                        return content
            if hasattr(first, "message"):
                message = getattr(first, "message")
                text = _extract_message_text(message)
                if text:
                    return text

    if isinstance(chunk, dict):
        choices = chunk.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                delta = first.get("delta")
                if isinstance(delta, dict):
                    content = delta.get("content")
                    if isinstance(content, str):
                        return content
                message = first.get("message")
                if isinstance(message, dict):
                    content = message.get("content")
                    if isinstance(content, str):
                        return content

    return ""


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
