from __future__ import annotations

from dataclasses import dataclass
import json

from core.agents.models import AgentProfile
from core.common.openrouter import OpenRouterError, get_env, get_openrouter_client
from core.session.conversation_store import ConversationTurn


class FeedGenerationUnavailableError(RuntimeError):
    pass


@dataclass
class GeneratedPost:
    content: str
    topic_seed: str
    post_type: str


class FeedGenerator:
    """Generates feed posts with OpenRouter only."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        try:
            self._client = get_openrouter_client("FEED_MODEL_NAME", model_name)
        except OpenRouterError:
            self._client = None

    @staticmethod
    def build_from_env() -> "FeedGenerator":
        model_name = get_env("FEED_MODEL_NAME", get_env("CHAT_MODEL_NAME", "openai/gpt-5.2"))
        return FeedGenerator(model_name=model_name)

    def generate(
        self,
        *,
        agent_profile: AgentProfile,
        recent_turns: list[ConversationTurn],
        mood_label: str,
        mood_intensity: float,
    ) -> GeneratedPost:
        if self._client is None:
            raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置 OPENROUTER_API_KEY。")

        messages = _build_messages(
            agent_profile=agent_profile,
            recent_turns=recent_turns,
            mood_label=mood_label,
            mood_intensity=mood_intensity,
        )
        try:
            text = self._client.chat_text(
                messages=messages,
                max_tokens=768,
                temperature=0.85,
            )
        except OpenRouterError as exc:
            raise FeedGenerationUnavailableError("动态生成模型调用失败，请稍后重试。") from exc

        if not text:
            raise FeedGenerationUnavailableError("动态生成模型返回为空，请稍后重试。")
        try:
            return _parse_generated_post(text)
        except FeedGenerationUnavailableError:
            repaired = self._repair_json_output(text)
            return _parse_generated_post(repaired)

    def _repair_json_output(self, raw_text: str) -> str:
        if self._client is None:
            raise FeedGenerationUnavailableError("动态生成模型不可用，请先配置 OPENROUTER_API_KEY。")

        repair_messages = [
            {
                "role": "system",
                "content": (
                    "你是JSON修复器。"
                    "只输出一个合法JSON对象，不要输出其他内容。"
                    "目标格式: "
                    '{"content":"动态正文","topic_seed":"可直接发给AI的开场问题","post_type":"status|reflection|plan"}'
                ),
            },
            {
                "role": "user",
                "content": f"请将以下输出修复为目标JSON对象:\n{raw_text}",
            },
        ]
        try:
            repaired = self._client.chat_text(
                messages=repair_messages,
                max_tokens=512,
                temperature=0.0,
            )
        except OpenRouterError as exc:
            raise FeedGenerationUnavailableError("动态生成模型返回格式错误，请稍后重试。") from exc

        if not repaired:
            raise FeedGenerationUnavailableError("动态生成模型返回格式错误，请稍后重试。")
        return repaired


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
