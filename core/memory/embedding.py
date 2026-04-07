from __future__ import annotations

import math


class SimpleEmbeddingModel:
    """Deterministic lightweight embedding for local development."""

    def __init__(self, dim: int = 16) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vec = [0.0 for _ in range(self.dim)]
        if not text:
            return vec

        for index, ch in enumerate(text):
            slot = index % self.dim
            vec[slot] += (ord(ch) % 97) / 97.0

        norm = math.sqrt(sum(value * value for value in vec))
        if norm == 0:
            return vec
        return [value / norm for value in vec]
