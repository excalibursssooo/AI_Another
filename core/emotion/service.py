from __future__ import annotations

from core.emotion.models import EmotionResult, build_emotion_model_from_env
from core.emotion.policy import EmotionPolicy, EmotionPolicyConfig


class EmotionService:
    """Emotion service backed by model and policy."""

    def __init__(self, policy: EmotionPolicy, model: object) -> None:
        self.policy = policy
        self.model = model

    @staticmethod
    def build_from_env() -> "EmotionService":
        policy = EmotionPolicy(config=EmotionPolicyConfig.from_env())
        model = build_emotion_model_from_env()
        return EmotionService(policy=policy, model=model)

    def classify(self, message: str) -> EmotionResult:
        classify_method = getattr(self.model, "classify")
        return classify_method(message)

    def classify_debug(self, message: str) -> dict[str, object]:
        backend_name = getattr(self.model, "backend_name", "unknown")
        model_name = getattr(self.model, "model_name", "unknown")

        try:
            if hasattr(self.model, "classify_with_raw"):
                classify_with_raw = getattr(self.model, "classify_with_raw")
                raw_text, result = classify_with_raw(message)
            else:
                result = self.classify(message)
                raw_text = ""
        except Exception:
            result = EmotionResult(label="neutral", intensity=0.2)
            raw_text = "当前无法调用大模型"

        return {
            "backend": backend_name,
            "model": model_name,
            "raw_text": raw_text,
            "parsed": {
                "label": result.label,
                "intensity": result.intensity,
            },
            "empathy_prefix": self.empathy_prefix(result),
        }

    def empathy_prefix(self, emotion: EmotionResult) -> str:
        return self.policy.empathy_prefix(emotion)
