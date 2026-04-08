from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from core.agents.models import AgentProfile
from core.session.conversation_store import ConversationTurn


class FeedGenerationUnavailableError(RuntimeError):
    pass


@dataclass
class GeneratedPost:
    content: str
    topic_seed: str
    post_type: str


class FeedGenerator:
    """Generates feed posts with LLM only (no rule fallback)."""

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
                raise RuntimeError("langchain-openai is required for FeedGenerator") from exc

            self._llm = ChatOpenAI(
                model=model_name,
                temperature=0.85,
                model_kwargs={"max_tokens": 768},
                api_key=SecretStr(api_key),
                base_url="https://open.bigmodel.cn/api/paas/v4/",
            )
            return

        try:
            from zai import ZhipuAiClient  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("zai-sdk is required for FeedGenerator") from exc

        self._client = ZhipuAiClient(api_key=api_key)

    @staticmethod
    def build_from_env() -> "FeedGenerator":
        api_key = _get_env("ZAI_API_KEY", _get_env("ZHIPU_API_KEY", ""))
        model_name = _get_env("FEED_MODEL_NAME", _get_env("CHAT_MODEL_NAME", "glm-4.7-flash"))
        runtime = _get_env("FEED_RUNTIME", _get_env("CHAT_RUNTIME", "langchain"))
        return FeedGenerator(api_key=api_key or None, model_name=model_name, runtime=runtime)

    def generate(
        self,
        *,
        agent_profile: AgentProfile,
        recent_turns: list[ConversationTurn],
        mood_label: str,
        mood_intensity: float,
    ) -> GeneratedPost:
        if self._runtime == "langchain":
            if self._llm is None:
                raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置可用模型。")
            return self._generate_with_langchain(
                agent_profile=agent_profile,
                recent_turns=recent_turns,
                mood_label=mood_label,
                mood_intensity=mood_intensity,
            )

        if self._client is None:
            raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置可用模型。")

        messages = _build_messages(
            agent_profile=agent_profile,
            recent_turns=recent_turns,
            mood_label=mood_label,
            mood_intensity=mood_intensity,
        )
        try:
            response: Any = self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
                thinking={"type": "disabled"},
                max_tokens=768,
                temperature=0.85,
            )
        except Exception as exc:
            raise FeedGenerationUnavailableError("动态生成模型调用失败，请稍后重试。") from exc

        text = _extract_message_text(response.choices[0].message)
        if not text:
            raise FeedGenerationUnavailableError("动态生成模型返回为空，请稍后重试。")
        return _parse_generated_post(text)

    def _generate_with_langchain(
        self,
        *,
        agent_profile: AgentProfile,
        recent_turns: list[ConversationTurn],
        mood_label: str,
        mood_intensity: float,
    ) -> GeneratedPost:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置可用模型。") from exc

        messages = _build_messages(
            agent_profile=agent_profile,
            recent_turns=recent_turns,
            mood_label=mood_label,
            mood_intensity=mood_intensity,
        )
        try:
            llm = self._llm
            if llm is None:
                raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置可用模型。")
            response = llm.invoke(
                [
                    SystemMessage(content=messages[0]["content"]),
                    HumanMessage(content=messages[1]["content"]),
                ],
            )
        except Exception as exc:
            raise FeedGenerationUnavailableError("动态生成模型调用失败，请稍后重试。") from exc

        text = _extract_langchain_content(response)
        if not text:
            raise FeedGenerationUnavailableError("动态生成模型返回为空，请稍后重试。")
        return _parse_generated_post(text)


def _build_messages(
    *,
    agent_profile: AgentProfile,
    recent_turns: list[ConversationTurn],
    mood_label: str,
    mood_intensity: float,
) -> list[dict[str, str]]:
    shown_name = agent_profile.display_name or agent_profile.name
    history_lines: list[str] = []
    for turn in recent_turns[-6:]:
        role = "用户" if turn.role == "user" else shown_name
        history_lines.append(f"{role}: {turn.content}")
    history_text = "\n".join(history_lines) if history_lines else "无历史对话"

    system_prompt = (
        "你是一个高质量社交动态文案生成器，负责给AI角色生成一条自然、有人味的动态。"
        "必须只输出JSON对象，不要输出额外内容。"
    )

    user_prompt = (
        f"角色名: {shown_name}\n"
        f"角色设定: {agent_profile.persona}\n"
        f"角色背景: {agent_profile.background}\n"
        f"角色爱好: {'、'.join(agent_profile.hobbies) if agent_profile.hobbies else '无'}\n"
        f"说话风格: {agent_profile.speaking_style}\n"
        f"当前心情: {mood_label}, 强度: {mood_intensity:.2f}\n"
        f"最近对话: \n{history_text}\n"
        "请生成一条长度 25-120 字的中文动态，并给出可直接用于开启聊天的话题引导。"
        "输出JSON格式:"
        '{"content":"动态正文","topic_seed":"可直接发给AI的开场问题","post_type":"status|reflection|plan"}'
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


def _parse_generated_post(raw_text: str) -> GeneratedPost:
    normalized = _strip_fenced_json(raw_text)
    try:
        payload = json.loads(normalized)
    except Exception as exc:
        raise FeedGenerationUnavailableError("动态生成模型返回格式错误，请稍后重试。") from exc

    if not isinstance(payload, dict):
        raise FeedGenerationUnavailableError("动态生成模型返回格式错误，请稍后重试。")

    content = str(payload.get("content", "")).strip()
    topic_seed = str(payload.get("topic_seed", "")).strip()
    post_type = str(payload.get("post_type", "status")).strip().lower() or "status"

    if not content:
        raise FeedGenerationUnavailableError("动态生成失败：正文为空。")
    if not topic_seed:
        raise FeedGenerationUnavailableError("动态生成失败：话题引导为空。")
    if post_type not in {"status", "reflection", "plan"}:
        post_type = "status"

    return GeneratedPost(
        content=content,
        topic_seed=topic_seed,
        post_type=post_type,
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
