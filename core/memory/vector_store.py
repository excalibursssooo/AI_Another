from __future__ import annotations

from typing import Protocol


class VectorStore(Protocol):
    """Vector index contract for memory recall."""

    def upsert(self, item_id: str, vector: list[float], payload: dict[str, str]) -> None:
        ...

    def search(self, query_vector: list[float], user_id: str, agent_id: str, limit: int) -> list[str]:
        ...


class InMemoryVectorStore:
    """Simple cosine-like search over in-memory vectors."""

    def __init__(self) -> None:
        self._entries: dict[str, tuple[list[float], dict[str, str]]] = {}

    def upsert(self, item_id: str, vector: list[float], payload: dict[str, str]) -> None:
        self._entries[item_id] = (vector, payload)

    def search(self, query_vector: list[float], user_id: str, agent_id: str, limit: int) -> list[str]:
        scored: list[tuple[float, str]] = []
        for item_id, (vector, payload) in self._entries.items():
            if payload.get("user_id") != user_id:
                continue
            if payload.get("agent_id") != agent_id:
                continue
            score = _dot(query_vector, vector)
            scored.append((score, item_id))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item_id for _, item_id in scored[:limit]]


class QdrantVectorStore:
    """Qdrant vector store adapter. Requires qdrant-client."""

    def __init__(self, url: str, collection_name: str, vector_size: int) -> None:
        try:
            from qdrant_client import QdrantClient  # type: ignore
            from qdrant_client.http import models as qmodels  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("qdrant-client is required for QdrantVectorStore") from exc

        self._QdrantClient = QdrantClient
        self._qmodels = qmodels
        self._client = QdrantClient(url=url)
        self._collection_name = collection_name
        self._ensure_collection(vector_size=vector_size)

    def _ensure_collection(self, vector_size: int) -> None:
        if self._client.collection_exists(self._collection_name):
            return

        self._client.create_collection(
            collection_name=self._collection_name,
            vectors_config=self._qmodels.VectorParams(
                size=vector_size,
                distance=self._qmodels.Distance.COSINE,
            ),
        )

    def upsert(self, item_id: str, vector: list[float], payload: dict[str, str]) -> None:
        self._client.upsert(
            collection_name=self._collection_name,
            points=[
                self._qmodels.PointStruct(
                    id=item_id,
                    vector=vector,
                    payload=payload,
                ),
            ],
        )

    def search(self, query_vector: list[float], user_id: str, agent_id: str, limit: int) -> list[str]:
        points = self._client.query_points(
            collection_name=self._collection_name,
            query=query_vector,
            limit=limit,
            query_filter=self._qmodels.Filter(
                must=[
                    self._qmodels.FieldCondition(
                        key="user_id",
                        match=self._qmodels.MatchValue(value=user_id),
                    ),
                    self._qmodels.FieldCondition(
                        key="agent_id",
                        match=self._qmodels.MatchValue(value=agent_id),
                    ),
                ],
            ),
        ).points

        return [str(point.id) for point in points]


def _dot(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))
