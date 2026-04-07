from __future__ import annotations

from dataclasses import dataclass
import json
import os

from core.emotion.models import EmotionResult


@dataclass
class EmotionPolicyConfig:
    templates: dict[str, str]

    @staticmethod
    def default() -> "EmotionPolicyConfig":
        return EmotionPolicyConfig(
            templates={
                "sad": "我能感受到你现在很不容易，我会陪你一起理一理。",
                "anxious": "你现在可能压力有点大，我们可以先把事情拆小一点。",
                "angry": "我理解你现在很烦，这种感受是合理的。",
                "happy": "听起来这是件让你开心的事，真替你高兴。",
                "neutral": "我在认真听你说。",
            },
        )

    @staticmethod
    def from_env() -> "EmotionPolicyConfig":
        policy_path = os.getenv("EMOTION_POLICY_PATH", "")
        if not policy_path:
            return EmotionPolicyConfig.default()

        with open(policy_path, "r", encoding="utf-8") as file:
            data = json.load(file)

        templates = data.get("templates", {})
        if not isinstance(templates, dict):
            raise ValueError("templates must be a dict in emotion policy file")

        normalized = {str(k): str(v) for k, v in templates.items()}
        defaults = EmotionPolicyConfig.default().templates
        defaults.update(normalized)
        return EmotionPolicyConfig(templates=defaults)


class EmotionPolicy:
    """Configurable response tone policy."""

    def __init__(self, config: EmotionPolicyConfig) -> None:
        self._config = config

    def empathy_prefix(self, emotion: EmotionResult) -> str:
        return self._config.templates.get(emotion.label, self._config.templates["neutral"])
