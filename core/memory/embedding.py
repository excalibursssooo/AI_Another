from __future__ import annotations

import math
import httpx

from core.common.settings import get_env


def _normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vec))
    if norm == 0:
        return vec
    return [value / norm for value in vec]


class _FallbackDeterministicEmbedding:
    def __init__(self, dim: int) -> None:
        self.dim = dim

    def encode(self, text: str) -> list[float]:
        vec = [0.0 for _ in range(self.dim)]
        if not text:
            return vec

        for index, ch in enumerate(text):
            slot = index % self.dim
            vec[slot] += (ord(ch) % 97) / 97.0
        return _normalize(vec)


class _RemoteEmbeddingClient:
    def __init__(self, api_key: str, model_name: str, timeout_seconds: int = 30) -> None:
        if not api_key.strip():
            raise ValueError("OPENROUTER_API_KEY is required for remote embedding fallback")
        self._api_key = api_key.strip()
        self._model_name = model_name.strip()
        self._client = httpx.Client(timeout=max(5, int(timeout_seconds)))

    def encode(self, text: str) -> list[float]:
        payload = {
            "model": self._model_name,
            "input": text or "",
        }
        response = self._client.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        parsed = response.json()
        if not isinstance(parsed, dict):
            raise RuntimeError("embedding response payload is invalid")
        data = parsed.get("data")
        if not isinstance(data, list) or not data:
            raise RuntimeError("embedding response missing data")
        first = data[0]
        if not isinstance(first, dict):
            raise RuntimeError("embedding response entry is invalid")
        vector = first.get("embedding")
        if not isinstance(vector, list):
            raise RuntimeError("embedding vector is invalid")
        return [float(item) for item in vector]


class SimpleEmbeddingModel:
    """Semantic embedding model with remote fallback before deterministic fallback."""

    def __init__(self, dim: int = 16) -> None:
        self.dim = dim
        self._backend = "fallback_deterministic"
        self._fallback = _FallbackDeterministicEmbedding(dim=dim)
        self._remote_fallback: _RemoteEmbeddingClient | None = None
        self._model = None

        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer("Qwen/Qwen3-Embedding-0.6B")
            self._backend = "sentence_transformers"
        except Exception:
            self._model = None

        if self._model is None:
            api_key = get_env("OPENROUTER_API_KEY", "")
            fallback_model = get_env("EMBEDDING_FALLBACK_MODEL", "openai/text-embedding-3-small")
            if api_key.strip():
                try:
                    self._remote_fallback = _RemoteEmbeddingClient(
                        api_key=api_key,
                        model_name=fallback_model,
                    )
                    self._backend = "openrouter_embedding_fallback"
                except Exception:
                    self._remote_fallback = None

    def embed(self, text: str) -> list[float]:
        if self._model is not None:
            vector = self._model.encode(text or "", normalize_embeddings=True)
            if hasattr(vector, "tolist"):
                as_list = vector.tolist()
            else:
                as_list = list(vector)
            return [float(item) for item in as_list]
        if self._remote_fallback is not None:
            try:
                vector = self._remote_fallback.encode(text or "")
                return _normalize([float(item) for item in vector])
            except Exception:
                pass
        return self._fallback.encode(text)

    @property
    def backend(self) -> str:
        return self._backend
