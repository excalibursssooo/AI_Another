from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    """Centralized environment settings loaded from .env and process env."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    openrouter_site_url: str = Field(default="", alias="OPENROUTER_SITE_URL")
    openrouter_site_name: str = Field(default="", alias="OPENROUTER_SITE_NAME")

    chat_model_name: str = Field(default="openai/gpt-5.2", alias="CHAT_MODEL_NAME")
    feed_model_name: str = Field(default="", alias="FEED_MODEL_NAME")
    emotion_model_name: str = Field(default="openai/gpt-5.2", alias="EMOTION_MODEL_NAME")
    emotion_backend: str = Field(default="openrouter", alias="EMOTION_BACKEND")
    memory_extraction_model_name: str = Field(default="openai/gpt-5.2", alias="MEMORY_EXTRACTION_MODEL_NAME")
    memory_extraction_backend: str = Field(default="openrouter", alias="MEMORY_EXTRACTION_BACKEND")
    embedding_fallback_model: str = Field(default="openai/text-embedding-3-small", alias="EMBEDDING_FALLBACK_MODEL")
    agent_creator_model_name: str = Field(default="openai/gpt-5.2", alias="AGENT_CREATOR_MODEL_NAME")

    memory_repository: str = Field(default="postgres", alias="MEMORY_REPOSITORY")
    memory_vector: str = Field(default="qdrant", alias="MEMORY_VECTOR")
    postgres_dsn: str = Field(default="", alias="POSTGRES_DSN")
    qdrant_url: str = Field(default="http://localhost:6333", alias="QDRANT_URL")
    qdrant_collection: str = Field(default="companion_memory", alias="QDRANT_COLLECTION")

    feed_repository: str = Field(default="postgres", alias="FEED_REPOSITORY")
    feed_json_path: str = Field(default="data/posts.json", alias="FEED_JSON_PATH")
    agent_repository: str = Field(default="postgres", alias="AGENT_REPOSITORY")
    agent_json_path: str = Field(default="data/agents.json", alias="AGENT_JSON_PATH")
    task_repository: str = Field(default="postgres", alias="TASK_REPOSITORY")
    task_json_path: str = Field(default="data/tasks.json", alias="TASK_JSON_PATH")
    conversation_repository: str = Field(default="postgres", alias="CONVERSATION_REPOSITORY")
    conversation_json_path: str = Field(default="data/conversations.json", alias="CONVERSATION_JSON_PATH")

    domain_enabled: str = Field(default="false", alias="DOMAIN_ENABLED")
    default_domain_id: str = Field(default="default", alias="DEFAULT_DOMAIN_ID")
    domain_config_dir: str = Field(default="data/domains", alias="DOMAIN_CONFIG_DIR")

    audit_log_enabled: str = Field(default="true", alias="AUDIT_LOG_ENABLED")
    audit_log_path: str = Field(default="logs/audit.jsonl", alias="AUDIT_LOG_PATH")

    memory_async_write: str = Field(default="true", alias="MEMORY_ASYNC_WRITE")
    auth_jwt_secret: str = Field(default="", alias="AUTH_JWT_SECRET")
    auth_jwt_algorithm: str = Field(default="HS256", alias="AUTH_JWT_ALGORITHM")
    auth_jwt_audience: str = Field(default="", alias="AUTH_JWT_AUDIENCE")


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    return AppSettings()


def get_env(key: str, default: str) -> str:
    settings = get_settings()
    values = settings.model_dump(by_alias=True)
    raw = values.get(key)
    if raw is None:
        return default
    value = str(raw).strip()
    return value if value else default
