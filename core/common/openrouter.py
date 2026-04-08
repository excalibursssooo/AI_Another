from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import requests


class OpenRouterError(RuntimeError):
    pass


class OpenRouterClient:
    """Minimal OpenRouter chat client shared by all AI modules."""

    def __init__(
        self,
        *,
        api_key: str,
        model_name: str,
        site_url: str | None = None,
        site_name: str | None = None,
        timeout_seconds: int = 60,
    ) -> None:
        if not api_key.strip():
            raise OpenRouterError("OPENROUTER_API_KEY is required")
        self._api_key = api_key.strip()
        self._model_name = model_name.strip()
        self._site_url = (site_url or "").strip() or None
        self._site_name = (site_name or "").strip() or None
        self._timeout_seconds = max(5, timeout_seconds)

    def chat_text(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        model_name: str | None = None,
    ) -> str:
        payload = self.chat_json(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            model_name=model_name,
        )
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise OpenRouterError("OpenRouter response missing choices")

        first = choices[0]
        if not isinstance(first, dict):
            raise OpenRouterError("OpenRouter response choice format invalid")

        message_obj = first.get("message")
        if not isinstance(message_obj, dict):
            raise OpenRouterError("OpenRouter response missing message")

        content = message_obj.get("content")
        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
                elif isinstance(item, str) and item.strip():
                    parts.append(item.strip())
            return "\n".join(parts).strip()

        raise OpenRouterError("OpenRouter response content is empty")

    def chat_json(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        model_name: str | None = None,
    ) -> dict[str, Any]:
        if not messages:
            raise OpenRouterError("messages cannot be empty")

        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        if self._site_url:
            headers["HTTP-Referer"] = self._site_url
        if self._site_name:
            headers["X-OpenRouter-Title"] = self._site_name

        payload = {
            "model": model_name or self._model_name,
            "messages": messages,
            "max_tokens": max(1, int(max_tokens)),
            "temperature": float(temperature),
        }

        try:
            response = requests.post(
                url="https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                data=json.dumps(payload, ensure_ascii=False),
                timeout=self._timeout_seconds,
            )
        except Exception as exc:
            raise OpenRouterError(f"OpenRouter request failed: {exc}") from exc

        if response.status_code >= 400:
            body = response.text.strip()
            detail = body[:500] if body else "no response body"
            raise OpenRouterError(f"OpenRouter HTTP {response.status_code}: {detail}")

        try:
            parsed = response.json()
        except Exception as exc:
            raise OpenRouterError("OpenRouter returned non-JSON response") from exc

        if not isinstance(parsed, dict):
            raise OpenRouterError("OpenRouter JSON payload must be an object")

        return parsed


def get_env(key: str, default: str) -> str:
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


def get_openrouter_client(model_env_key: str, default_model: str) -> OpenRouterClient:
    api_key = get_env("OPENROUTER_API_KEY", "")
    site_url = get_env("OPENROUTER_SITE_URL", "")
    site_name = get_env("OPENROUTER_SITE_NAME", "")
    model_name = get_env(model_env_key, default_model)
    if not api_key:
        raise OpenRouterError("OPENROUTER_API_KEY is missing")
    return OpenRouterClient(
        api_key=api_key,
        model_name=model_name,
        site_url=site_url,
        site_name=site_name,
    )
