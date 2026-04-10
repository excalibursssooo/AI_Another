from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, TypeVar

import httpx
from threading import Lock

from core.common.settings import get_env


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

    async def chat_text_async(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        model_name: str | None = None,
    ) -> str:
        payload = await self.chat_json_async(
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

    async def chat_json_async(
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
            client = await _get_async_client(timeout_seconds=self._timeout_seconds)
            response = await client.post(
                url="https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                content=json.dumps(payload, ensure_ascii=False),
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
            client = _get_sync_client(timeout_seconds=self._timeout_seconds)
            response = client.post(
                url="https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                content=json.dumps(payload, ensure_ascii=False),
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

    def chat_text(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        model_name: str | None = None,
    ) -> str:
        return _run_async(
            self.chat_text_async(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                model_name=model_name,
            ),
        )


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


T = TypeVar("T")


_CLIENT_LOCK = Lock()
_SYNC_CLIENT: httpx.Client | None = None
_ASYNC_CLIENT: httpx.AsyncClient | None = None


def _get_sync_client(timeout_seconds: int) -> httpx.Client:
    global _SYNC_CLIENT
    with _CLIENT_LOCK:
        if _SYNC_CLIENT is None:
            _SYNC_CLIENT = httpx.Client(timeout=max(5, int(timeout_seconds)))
    return _SYNC_CLIENT


async def _get_async_client(timeout_seconds: int) -> httpx.AsyncClient:
    global _ASYNC_CLIENT
    with _CLIENT_LOCK:
        if _ASYNC_CLIENT is None:
            _ASYNC_CLIENT = httpx.AsyncClient(timeout=max(5, int(timeout_seconds)))
    return _ASYNC_CLIENT


async def close_openrouter_clients() -> None:
    global _SYNC_CLIENT, _ASYNC_CLIENT
    sync_client: httpx.Client | None = None
    async_client: httpx.AsyncClient | None = None
    with _CLIENT_LOCK:
        sync_client = _SYNC_CLIENT
        async_client = _ASYNC_CLIENT
        _SYNC_CLIENT = None
        _ASYNC_CLIENT = None

    if sync_client is not None:
        sync_client.close()
    if async_client is not None:
        await async_client.aclose()


def _run_async(awaitable: Awaitable[T]) -> T:
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            raise OpenRouterError("Synchronous OpenRouter call inside running event loop is not allowed")
    except RuntimeError:
        pass

    return asyncio.run(awaitable)
