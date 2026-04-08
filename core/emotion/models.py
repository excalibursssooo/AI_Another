from __future__ import annotations

from dataclasses import dataclass
import json

from core.common.openrouter import OpenRouterError, get_env, get_openrouter_client


@dataclass
class EmotionResult:
    label: str
    intensity: float


class OpenRouterEmotionModel:
    """OpenRouter-backed classifier with deterministic JSON output."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        self._client = get_openrouter_client("EMOTION_MODEL_NAME", model_name)

    def classify(self, message: str) -> EmotionResult:
        _, result = self.classify_with_raw(message)
        return result

    def classify_with_raw(self, message: str) -> tuple[str, EmotionResult]:
        text = self._client.chat_text(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是情绪分类器。请基于用户文本判断情绪并只输出 JSON，"
                        "格式必须是: "
                        '{"label":"happy|sad|anxious|angry|neutral","intensity":0-1}'
                    ),
                },
                {"role": "user", "content": message},
            ],
            max_tokens=512,
            temperature=0.1,
        )
        return text, _parse_emotion_result(text)

    @property
    def backend_name(self) -> str:
        return "openrouter"

    @property
    def model_name(self) -> str:
        return self._model_name


class UnavailableEmotionModel:
    """Model placeholder used when runtime config is invalid."""

    def __init__(self, reason: str) -> None:
        self._reason = reason

    def classify(self, message: str) -> EmotionResult:
        raise RuntimeError(self._reason)

    def classify_with_raw(self, message: str) -> tuple[str, EmotionResult]:
        raise RuntimeError(self._reason)

    @property
    def backend_name(self) -> str:
        return "openrouter"

    @property
    def model_name(self) -> str:
        return "unavailable"


def build_emotion_model_from_env() -> object:
    backend = get_env("EMOTION_BACKEND", "openrouter").strip().lower()
    if backend != "openrouter":
        return UnavailableEmotionModel("only openrouter backend is supported")

    model_name = get_env("EMOTION_MODEL_NAME", "openai/gpt-5.2")
    try:
        return OpenRouterEmotionModel(model_name=model_name)
    except OpenRouterError as exc:
        return UnavailableEmotionModel(str(exc))


def _parse_emotion_result(text: str) -> EmotionResult:
    normalized = _strip_fenced_json(text)
    try:
        data = json.loads(normalized)
        label = str(data.get("label", "neutral"))
        intensity = float(data.get("intensity", 0.2))
    except Exception:
        label = "neutral"
        intensity = 0.2

    return EmotionResult(label=label, intensity=max(0.0, min(1.0, intensity)))


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
