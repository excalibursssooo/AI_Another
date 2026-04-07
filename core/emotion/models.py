from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any, Protocol

from pydantic import SecretStr


@dataclass
class EmotionResult:
    label: str
    intensity: float


class EmotionModel(Protocol):
    """Model contract for emotion classification."""

    def classify(self, message: str) -> EmotionResult:
        ...

    def classify_with_raw(self, message: str) -> tuple[str, EmotionResult]:
        ...

    @property
    def backend_name(self) -> str:
        ...

    @property
    def model_name(self) -> str:
        ...


class LangChainZhipuEmotionModel:
    """LangChain + Zhipu(OpenAI compatible) backed classifier."""

    def __init__(self, api_key: str, model_name: str) -> None:
        try:
            from langchain_openai import ChatOpenAI  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("langchain-openai is required for LangChainZhipuEmotionModel") from exc

        self._model_name = model_name
        self._llm = ChatOpenAI(
            model=model_name,
            temperature=0.1,
            model_kwargs={"max_tokens": 1024},
            api_key=SecretStr(api_key),
            base_url="https://open.bigmodel.cn/api/paas/v4/",
        )

    def classify(self, message: str) -> EmotionResult:
        _, result = self.classify_with_raw(message)
        return result

    def classify_with_raw(self, message: str) -> tuple[str, EmotionResult]:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("langchain-core is required for LangChainZhipuEmotionModel") from exc

        response = self._llm.invoke(
            [
                SystemMessage(
                    content=(
                        "你是情绪分类器。请基于用户文本判断情绪并只输出 JSON，"
                        "格式必须是: "
                        '{"label":"happy|sad|anxious|angry|neutral","intensity":0-1}'
                    ),
                ),
                HumanMessage(content=message),
            ],
        )
        text = response.content if isinstance(response.content, str) else str(response.content)
        return text, _parse_emotion_result(text)

    @property
    def backend_name(self) -> str:
        return "zhipu-langchain"

    @property
    def model_name(self) -> str:
        return self._model_name


class ZhipuEmotionModel:
    """Zhipu-backed classifier with deterministic JSON output."""

    def __init__(self, api_key: str, model_name: str) -> None:
        try:
            from zai import ZhipuAiClient  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("zai-sdk is required for ZhipuEmotionModel") from exc

        self._client = ZhipuAiClient(api_key=api_key)
        self._model_name = model_name

    def classify(self, message: str) -> EmotionResult:
        _, result = self.classify_with_raw(message)
        return result

    def classify_with_raw(self, message: str) -> tuple[str, EmotionResult]:
        response: Any = self._client.chat.completions.create(
            model=self._model_name,
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
            thinking={"type": "disabled"},
            max_tokens=512,
            temperature=0.1,
        )

        raw_message = response.choices[0].message
        text = _extract_message_text(raw_message)
        return text, _parse_emotion_result(text)

    @property
    def backend_name(self) -> str:
        return "zhipu"

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
        return "zhipu"

    @property
    def model_name(self) -> str:
        return "unavailable"


def build_emotion_model_from_env() -> EmotionModel:
    backend = _get_env("EMOTION_BACKEND", "zhipu")
    if backend != "zhipu":
        return UnavailableEmotionModel("only zhipu backend is supported")

    api_key = _get_env("ZAI_API_KEY", _get_env("ZHIPU_API_KEY", ""))
    model_name = _get_env("EMOTION_MODEL_NAME", "glm-4.7-flash")
    runtime = _get_env("EMOTION_RUNTIME", "langchain")
    if not api_key:
        return UnavailableEmotionModel("ZHIPU_API_KEY is required when EMOTION_BACKEND=zhipu")

    if runtime == "langchain":
        try:
            return LangChainZhipuEmotionModel(api_key=api_key, model_name=model_name)
        except Exception as exc:
            return UnavailableEmotionModel(f"langchain runtime unavailable: {exc}")

    try:
        return ZhipuEmotionModel(api_key=api_key, model_name=model_name)
    except Exception as exc:
        return UnavailableEmotionModel(f"zai runtime unavailable: {exc}")


def _get_env(key: str, default: str) -> str:
    value = os.getenv(key)
    if value:
        return value

    dotenv_value = _read_from_dotenv(key)
    if dotenv_value:
        return dotenv_value
    return default


def _read_from_dotenv(key: str) -> str | None:
    project_root = Path(__file__).resolve().parents[2]
    dotenv_path = project_root / ".env"
    if not dotenv_path.exists():
        return None

    with dotenv_path.open("r", encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            env_key, env_value = line.split("=", 1)
            if env_key.strip() != key:
                continue

            cleaned = env_value.strip().strip('"').strip("'")
            return cleaned
    return None


def _extract_message_text(raw_message: object) -> str:
    # zai-sdk may return message as object or dict depending on version.
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


def _parse_emotion_result(text: str) -> EmotionResult:
    try:
        data = json.loads(text)
        label = str(data.get("label", "neutral"))
        intensity = float(data.get("intensity", 0.2))
    except Exception:
        label = "neutral"
        intensity = 0.2

    return EmotionResult(label=label, intensity=max(0.0, min(1.0, intensity)))
