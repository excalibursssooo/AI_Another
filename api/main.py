from __future__ import annotations

import json
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
import os
from pathlib import Path
from pydantic import BaseModel, Field
import socket
from starlette.responses import StreamingResponse
from typing import Iterator
from urllib.parse import urlparse
from urllib.request import urlopen

from core.agents.service import AgentAICreationError, AgentService
from core.emotion.service import EmotionService
from core.memory.service import MemoryService
from core.safety.service import SafetyService
from core.session.conversation_store import ConversationStore
from core.session.orchestrator import SessionOrchestrator
from core.session.reply_generator import ReplyGenerator
from core.tasks.models import TaskDraft
from core.tasks.service import TaskService


app = FastAPI(title="Companion Agent MVP", version="0.1.0")

_cors_origins_raw = os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
_cors_origins = [item.strip() for item in _cors_origins_raw.split(",") if item.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

memory_service = MemoryService.build_from_env()
emotion_service = EmotionService.build_from_env()
safety_service = SafetyService()
reply_generator = ReplyGenerator.build_from_env()
conversation_store = ConversationStore.build_from_env()
agent_service = AgentService.build_from_env()
task_service = TaskService.build_from_env()
orchestrator = SessionOrchestrator(
    memory_service=memory_service,
    emotion_service=emotion_service,
    safety_service=safety_service,
    reply_generator=reply_generator,
    conversation_store=conversation_store,
)


class ChatRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1, max_length=2000)
    conversation_id: str | None = Field(default=None, min_length=1)
    agent_id: str = Field(default="default", min_length=1)


class ChatResponse(BaseModel):
    reply: str
    agent_id: str
    agent_name: str
    emotion_label: str
    risk_level: str
    recalled_memories: list[dict[str, str]]
    persisted_memory_count: int


class ConversationTurnResponse(BaseModel):
    role: str
    content: str
    created_at: str


class AgentCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    persona: str = Field(..., min_length=1, max_length=1000)
    background: str = Field(..., min_length=1, max_length=500)
    hobbies: list[str] = Field(default_factory=list)
    speaking_style: str = Field(default="warm", min_length=1, max_length=400)


class AgentUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    persona: str = Field(..., min_length=1, max_length=1000)
    background: str = Field(..., min_length=1, max_length=500)
    hobbies: list[str] = Field(default_factory=list)
    speaking_style: str = Field(default="warm", min_length=1, max_length=400)
    status: str = Field(default="active", pattern="^(active|inactive)$")


class AgentResponse(BaseModel):
    id: str
    name: str
    display_name: str
    persona: str
    background: str
    hobbies: list[str]
    speaking_style: str
    status: str
    created_at: str
    updated_at: str


class AgentAICreateRequest(BaseModel):
    prompt: str | None = Field(default=None, min_length=5, max_length=1500)


class AgentAICreateResponse(BaseModel):
    agent: AgentResponse
    backend: str
    model: str
    used_prompt: str
    raw_text: str


class AgentMemorySeedDebugRequest(BaseModel):
    dry_run: bool = Field(default=True)
    force_reextract: bool = Field(default=False)


class AgentMemorySeedCandidateResponse(BaseModel):
    subject: str
    memory_type: str
    content: str
    confidence: float
    importance: float


class AgentMemorySeedDebugResponse(BaseModel):
    agent_id: str
    agent_name: str
    dry_run: bool
    force_reextract: bool
    skipped_existing: bool
    existing_count: int
    used_fallback: bool
    extraction_backend: str
    extraction_model: str
    extraction_is_llm: bool
    extraction_reason: str
    raw_text: str
    candidate_count: int
    persisted_count: int
    candidates: list[AgentMemorySeedCandidateResponse]


class EmotionDebugRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)


class EmotionParsedResult(BaseModel):
    label: str
    intensity: float


class EmotionDebugResponse(BaseModel):
    backend: str
    model: str
    raw_text: str
    parsed: EmotionParsedResult
    empathy_prefix: str


class InfraTargetStatus(BaseModel):
    enabled: bool
    configured: bool
    reachable: bool
    detail: str


class InfraDebugResponse(BaseModel):
    memory_repository: str
    memory_vector: str
    emotion_backend: str
    emotion_model: str
    zhipu_api_key_present: bool
    postgres: InfraTargetStatus
    qdrant: InfraTargetStatus


class TaskDraftRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)


class TaskDraftResponse(BaseModel):
    has_task_intent: bool
    draft: dict[str, object] | None


class MemoryResponse(BaseModel):
    id: str
    user_id: str
    agent_id: str
    subject: str
    memory_type: str
    content: str
    confidence: float
    importance: float
    status: str
    created_at: str


class MemoryExtractDebugRequest(BaseModel):
    message: str | None = Field(default=None, min_length=1, max_length=2000)
    user_message: str | None = Field(default=None, min_length=1, max_length=2000)
    assistant_reply: str | None = Field(default=None, min_length=1, max_length=2000)
    agent_name: str = Field(default="assistant", min_length=1, max_length=40)
    memory_text: str = Field(default="", max_length=40000)


class MemoryCandidateResponse(BaseModel):
    subject: str
    memory_type: str
    content: str
    confidence: float
    importance: float


class MemoryExtractDebugResponse(BaseModel):
    backend: str
    model: str
    is_llm: bool
    system_prompt: str
    user_content: str
    raw_response: str
    raw_text: str
    reason: str
    candidates: list[MemoryCandidateResponse]


class MemoryStatusRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    agent_id: str = Field(default="default", min_length=1)


class TaskConfirmRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    source_message: str = Field(..., min_length=1, max_length=2000)
    title: str = Field(..., min_length=1, max_length=120)
    priority: str = Field(default="medium")
    deadline: str | None = None
    subtasks: list[str] = Field(default_factory=list)


class TaskResponse(BaseModel):
    id: str
    user_id: str
    title: str
    status: str
    priority: str
    deadline: str | None
    subtasks: list[str]
    source_message: str
    created_at: str


class TelemetryAckResponse(BaseModel):
    status: str


class FrontendHeartbeatRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=120)
    page: str = Field(..., min_length=1, max_length=500)
    mode: str = Field(default="unknown", max_length=40)
    user_id: str | None = Field(default=None, max_length=120)
    app_version: str | None = Field(default=None, max_length=80)


class FrontendErrorRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    page: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="window", max_length=200)
    stack: str | None = Field(default=None, max_length=12000)
    app_version: str | None = Field(default=None, max_length=80)
    user_id: str | None = Field(default=None, max_length=120)


class WebVitalRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    value: float
    rating: str | None = Field(default=None, max_length=20)
    page: str = Field(..., min_length=1, max_length=500)
    metric_id: str | None = Field(default=None, max_length=120)
    app_version: str | None = Field(default=None, max_length=80)


class TelemetryOverviewResponse(BaseModel):
    heartbeat_count: int
    frontend_error_count: int
    web_vitals_count: int
    latest_heartbeat: dict[str, object] | None
    latest_error: dict[str, object] | None
    latest_web_vital: dict[str, object] | None


MAX_TELEMETRY_ITEMS = 500
TELEMETRY_ENABLED = os.getenv("TELEMETRY_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
_frontend_heartbeats: list[dict[str, object]] = []
_frontend_errors: list[dict[str, object]] = []
_web_vitals: list[dict[str, object]] = []


def _append_telemetry(buffer: list[dict[str, object]], payload: dict[str, object]) -> None:
    buffer.append(payload)
    if len(buffer) > MAX_TELEMETRY_ITEMS:
        del buffer[0 : len(buffer) - MAX_TELEMETRY_ITEMS]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/telemetry/heartbeat", response_model=TelemetryAckResponse)
def telemetry_heartbeat(req: FrontendHeartbeatRequest) -> TelemetryAckResponse:
    if not TELEMETRY_ENABLED:
        return TelemetryAckResponse(status="disabled")

    payload = {
        "session_id": req.session_id,
        "page": req.page,
        "mode": req.mode,
        "user_id": req.user_id,
        "app_version": req.app_version,
    }
    _append_telemetry(_frontend_heartbeats, payload)
    return TelemetryAckResponse(status="ok")


@app.post("/telemetry/frontend-error", response_model=TelemetryAckResponse)
def telemetry_frontend_error(req: FrontendErrorRequest) -> TelemetryAckResponse:
    if not TELEMETRY_ENABLED:
        return TelemetryAckResponse(status="disabled")

    payload = {
        "message": req.message,
        "page": req.page,
        "source": req.source,
        "stack": req.stack,
        "app_version": req.app_version,
        "user_id": req.user_id,
    }
    _append_telemetry(_frontend_errors, payload)
    return TelemetryAckResponse(status="ok")


@app.post("/telemetry/web-vitals", response_model=TelemetryAckResponse)
def telemetry_web_vitals(req: WebVitalRequest) -> TelemetryAckResponse:
    if not TELEMETRY_ENABLED:
        return TelemetryAckResponse(status="disabled")

    payload = {
        "name": req.name,
        "value": req.value,
        "rating": req.rating,
        "page": req.page,
        "metric_id": req.metric_id,
        "app_version": req.app_version,
    }
    _append_telemetry(_web_vitals, payload)
    return TelemetryAckResponse(status="ok")


@app.get("/telemetry/overview", response_model=TelemetryOverviewResponse)
def telemetry_overview() -> TelemetryOverviewResponse:
    if not TELEMETRY_ENABLED:
        return TelemetryOverviewResponse(
            heartbeat_count=0,
            frontend_error_count=0,
            web_vitals_count=0,
            latest_heartbeat=None,
            latest_error=None,
            latest_web_vital=None,
        )

    return TelemetryOverviewResponse(
        heartbeat_count=len(_frontend_heartbeats),
        frontend_error_count=len(_frontend_errors),
        web_vitals_count=len(_web_vitals),
        latest_heartbeat=_frontend_heartbeats[-1] if _frontend_heartbeats else None,
        latest_error=_frontend_errors[-1] if _frontend_errors else None,
        latest_web_vital=_web_vitals[-1] if _web_vitals else None,
    )


@app.post("/chat")
def chat(req: ChatRequest) -> StreamingResponse:
    selected_agent = agent_service.get_agent(req.agent_id)
    if selected_agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    if selected_agent.status != "active":
        raise HTTPException(status_code=400, detail="agent is not active")

    resolved_conversation_id = req.conversation_id or req.agent_id
    if resolved_conversation_id != req.agent_id:
        raise HTTPException(
            status_code=400,
            detail="one agent must map to one conversation: conversation_id must equal agent_id",
        )

    stream_iter = orchestrator.stream_handle_message(
        user_id=req.user_id,
        message=req.message,
        conversation_id=resolved_conversation_id,
        agent_profile=selected_agent,
    )

    def event_stream() -> Iterator[str]:
        for event in stream_iter:
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/conversations", response_model=list[ConversationTurnResponse])
def list_conversation_turns(user_id: str, agent_id: str, limit: int = 100) -> list[ConversationTurnResponse]:
    if limit <= 0:
        return []

    bounded_limit = min(limit, 500)
    conversation_key = f"{user_id}:{agent_id}"
    turns = conversation_store.recent(user_id=conversation_key, limit=bounded_limit)
    return [
        ConversationTurnResponse(
            role=item.role,
            content=item.content,
            created_at=item.created_at.isoformat(),
        )
        for item in turns
    ]


@app.post("/agents", response_model=AgentResponse)
def create_agent(req: AgentCreateRequest) -> AgentResponse:
    profile = agent_service.create_agent(
        name=req.name,
        persona=req.persona,
        background=req.background,
        hobbies=req.hobbies,
        speaking_style=req.speaking_style,
    )
    _seed_agent_profile_memories(profile.id)
    return AgentResponse(
        id=profile.id,
        name=profile.name,
        display_name=profile.display_name or profile.name,
        persona=profile.persona,
        background=profile.background,
        hobbies=profile.hobbies,
        speaking_style=profile.speaking_style,
        status=profile.status,
        created_at=profile.created_at.isoformat(),
        updated_at=profile.updated_at.isoformat(),
    )


@app.post("/agents/ai-create", response_model=AgentAICreateResponse)
def create_agent_by_ai(req: AgentAICreateRequest) -> AgentAICreateResponse:
    try:
        profile, debug = agent_service.create_agent_by_ai_debug(req.prompt)
    except AgentAICreationError as exc:
        debug = exc.debug_info
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(exc),
                "backend": str(debug.get("backend", "unknown")),
                "model": str(debug.get("model", "unknown")),
                "used_prompt": str(debug.get("prompt", "")),
                "raw_text": str(debug.get("raw_text", ""))[:4000],
                "parse_error": str(debug.get("parse_error", "")),
            },
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    _seed_agent_profile_memories(profile.id)

    return AgentAICreateResponse(
        agent=AgentResponse(
            id=profile.id,
            name=profile.name,
            display_name=profile.display_name or profile.name,
            persona=profile.persona,
            background=profile.background,
            hobbies=profile.hobbies,
            speaking_style=profile.speaking_style,
            status=profile.status,
            created_at=profile.created_at.isoformat(),
            updated_at=profile.updated_at.isoformat(),
        ),
        backend=str(debug.get("backend", "unknown")),
        model=str(debug.get("model", "unknown")),
        used_prompt=str(debug.get("prompt", "")),
        raw_text=str(debug.get("raw_text", "")),
    )


@app.post("/agents/{agent_id}/memory-seed/debug", response_model=AgentMemorySeedDebugResponse)
def debug_agent_memory_seed(agent_id: str, req: AgentMemorySeedDebugRequest) -> AgentMemorySeedDebugResponse:
    profile = agent_service.get_agent(agent_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="agent not found")

    debug = memory_service.debug_agent_profile_memory_seed(
        profile=profile,
        dry_run=req.dry_run,
        force_reextract=req.force_reextract,
    )

    extraction_debug_obj = debug.get("extraction_debug", {})
    extraction_debug: dict[str, object]
    if isinstance(extraction_debug_obj, dict):
        extraction_debug = extraction_debug_obj
    else:
        extraction_debug = {}

    candidates_obj = debug.get("candidates", [])
    candidates: list[AgentMemorySeedCandidateResponse] = []
    if isinstance(candidates_obj, list):
        for item in candidates_obj:
            if not isinstance(item, dict):
                continue
            try:
                candidates.append(
                    AgentMemorySeedCandidateResponse(
                        subject=str(item.get("subject", "user")),
                        memory_type=str(item.get("memory_type", "")),
                        content=str(item.get("content", "")),
                        confidence=float(item.get("confidence", 0.0)),
                        importance=float(item.get("importance", 0.0)),
                    ),
                )
            except (TypeError, ValueError):
                continue

    return AgentMemorySeedDebugResponse(
        agent_id=profile.id,
        agent_name=profile.name,
        dry_run=bool(debug.get("dry_run", True)),
        force_reextract=bool(debug.get("force_reextract", False)),
        skipped_existing=bool(debug.get("skipped_existing", False)),
        existing_count=int(debug.get("existing_count", 0)),
        used_fallback=bool(debug.get("used_fallback", False)),
        extraction_backend=str(extraction_debug.get("backend", "unknown")),
        extraction_model=str(extraction_debug.get("model", "unknown")),
        extraction_is_llm=bool(extraction_debug.get("is_llm", False)),
        extraction_reason=str(extraction_debug.get("reason", "")),
        raw_text=str(extraction_debug.get("raw_text", "")),
        candidate_count=int(debug.get("candidate_count", 0)),
        persisted_count=int(debug.get("persisted_count", 0)),
        candidates=candidates,
    )


@app.get("/agents", response_model=list[AgentResponse])
def list_agents(include_inactive: bool = False) -> list[AgentResponse]:
    rows = agent_service.list_agents(include_inactive=include_inactive)
    return [
        AgentResponse(
            id=item.id,
            name=item.name,
            display_name=item.display_name or item.name,
            persona=item.persona,
            background=item.background,
            hobbies=item.hobbies,
            speaking_style=item.speaking_style,
            status=item.status,
            created_at=item.created_at.isoformat(),
            updated_at=item.updated_at.isoformat(),
        )
        for item in rows
    ]


@app.get("/agents/{agent_id}", response_model=AgentResponse)
def get_agent(agent_id: str) -> AgentResponse:
    item = agent_service.get_agent(agent_id)
    if item is None:
        raise HTTPException(status_code=404, detail="agent not found")

    return AgentResponse(
        id=item.id,
        name=item.name,
        display_name=item.display_name or item.name,
        persona=item.persona,
        background=item.background,
        hobbies=item.hobbies,
        speaking_style=item.speaking_style,
        status=item.status,
        created_at=item.created_at.isoformat(),
        updated_at=item.updated_at.isoformat(),
    )


@app.put("/agents/{agent_id}", response_model=AgentResponse)
def update_agent(agent_id: str, req: AgentUpdateRequest) -> AgentResponse:
    updated = agent_service.update_agent(
        agent_id=agent_id,
        name=req.name,
        persona=req.persona,
        background=req.background,
        hobbies=req.hobbies,
        speaking_style=req.speaking_style,
        status=req.status,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="agent not found")

    return AgentResponse(
        id=updated.id,
        name=updated.name,
        display_name=updated.display_name or updated.name,
        persona=updated.persona,
        background=updated.background,
        hobbies=updated.hobbies,
        speaking_style=updated.speaking_style,
        status=updated.status,
        created_at=updated.created_at.isoformat(),
        updated_at=updated.updated_at.isoformat(),
    )


@app.delete("/agents/{agent_id}", response_model=AgentResponse)
def delete_agent(agent_id: str) -> AgentResponse:
    try:
        deleted = agent_service.delete_agent(agent_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if deleted is None:
        raise HTTPException(status_code=404, detail="agent not found")

    return AgentResponse(
        id=deleted.id,
        name=deleted.name,
        display_name=deleted.display_name or deleted.name,
        persona=deleted.persona,
        background=deleted.background,
        hobbies=deleted.hobbies,
        speaking_style=deleted.speaking_style,
        status=deleted.status,
        created_at=deleted.created_at.isoformat(),
        updated_at=deleted.updated_at.isoformat(),
    )


@app.post("/emotion/debug", response_model=EmotionDebugResponse)
def emotion_debug(req: EmotionDebugRequest) -> EmotionDebugResponse:
    debug = emotion_service.classify_debug(req.message)
    parsed_obj = debug.get("parsed", {})
    parsed: dict[str, object]
    if isinstance(parsed_obj, dict):
        parsed = parsed_obj
    else:
        parsed = {}

    intensity_obj = parsed.get("intensity", 0.2)
    try:
        intensity_value = float(str(intensity_obj))
    except (TypeError, ValueError):
        intensity_value = 0.2

    return EmotionDebugResponse(
        backend=str(debug["backend"]),
        model=str(debug["model"]),
        raw_text=str(debug["raw_text"]),
        parsed=EmotionParsedResult(
            label=str(parsed.get("label", "neutral")),
            intensity=intensity_value,
        ),
        empathy_prefix=str(debug["empathy_prefix"]),
    )


@app.get("/infra/debug", response_model=InfraDebugResponse)
def infra_debug() -> InfraDebugResponse:
    memory_repository = _get_env("MEMORY_REPOSITORY", "memory")
    memory_vector = _get_env("MEMORY_VECTOR", "memory")
    emotion_backend = _get_env("EMOTION_BACKEND", "zhipu")
    emotion_model = _get_env("EMOTION_MODEL_NAME", "glm-4.7-flash")
    zhipu_api_key = _get_env("ZHIPU_API_KEY", "")

    postgres_dsn = _get_env("POSTGRES_DSN", "")
    postgres_status = _check_postgres(memory_repository == "postgres", postgres_dsn)

    qdrant_url = _get_env("QDRANT_URL", "http://localhost:6333")
    qdrant_status = _check_qdrant(memory_vector == "qdrant", qdrant_url)

    return InfraDebugResponse(
        memory_repository=memory_repository,
        memory_vector=memory_vector,
        emotion_backend=emotion_backend,
        emotion_model=emotion_model,
        zhipu_api_key_present=bool(zhipu_api_key),
        postgres=postgres_status,
        qdrant=qdrant_status,
    )


@app.post("/tasks/draft", response_model=TaskDraftResponse)
def draft_task(req: TaskDraftRequest) -> TaskDraftResponse:
    draft = task_service.draft_from_message(req.message)
    if draft is None:
        return TaskDraftResponse(has_task_intent=False, draft=None)

    return TaskDraftResponse(
        has_task_intent=True,
        draft={
            "title": draft.title,
            "priority": draft.priority,
            "deadline": draft.deadline,
            "subtasks": draft.subtasks,
        },
    )


@app.get("/memories", response_model=list[MemoryResponse])
def list_memories(user_id: str, agent_id: str = "default", status: str = "all") -> list[MemoryResponse]:
    memories = memory_service.list_memories(user_id=user_id, agent_id=agent_id, status=status)
    return [
        MemoryResponse(
            id=item.id,
            user_id=item.user_id,
            agent_id=item.agent_id,
            subject=item.subject,
            memory_type=item.memory_type,
            content=item.content,
            confidence=item.confidence,
            importance=item.importance,
            status=item.status,
            created_at=item.created_at.isoformat(),
        )
        for item in memories
    ]


@app.post("/memory/extract/debug", response_model=MemoryExtractDebugResponse)
def memory_extract_debug(req: MemoryExtractDebugRequest) -> MemoryExtractDebugResponse:
    if req.user_message and req.assistant_reply:
        debug_message = (
            f"你现在就是agent: {req.agent_name}。"
            "以下是你已经记住的历史记忆，请结合它们避免重复并判断是否需要新增记忆。\n"
            f"历史记忆:\n{req.memory_text}\n"
            "以下是对话，请判断是否需要新增长期记忆，并为每条记忆标注subject(user|agent)。\n"
            f"用户: {req.user_message}\n"
            f"{req.agent_name}: {req.assistant_reply}"
        )
        debug = memory_service.extract_candidates_debug(debug_message)
    elif req.message:
        debug = memory_service.extract_candidates_debug(req.message)
    else:
        raise HTTPException(
            status_code=400,
            detail="provide either message, or both user_message and assistant_reply",
        )

    candidates_obj = debug.get("candidates", [])
    candidates: list[MemoryCandidateResponse] = []

    if isinstance(candidates_obj, list):
        for item in candidates_obj:
            if not isinstance(item, dict):
                continue
            try:
                candidates.append(
                    MemoryCandidateResponse(
                        subject=str(item.get("subject", "user")),
                        memory_type=str(item.get("memory_type", "")),
                        content=str(item.get("content", "")),
                        confidence=float(item.get("confidence", 0.0)),
                        importance=float(item.get("importance", 0.0)),
                    ),
                )
            except (TypeError, ValueError):
                continue

    return MemoryExtractDebugResponse(
        backend=str(debug.get("backend", "unknown")),
        model=str(debug.get("model", "unknown")),
        is_llm=bool(debug.get("is_llm", False)),
        system_prompt=str(debug.get("system_prompt", "")),
        user_content=str(debug.get("user_content", "")),
        raw_response=str(debug.get("raw_response", "")),
        raw_text=str(debug.get("raw_text", "")),
        reason=str(debug.get("reason", "")),
        candidates=candidates,
    )


@app.post("/memories/{memory_id}/freeze", response_model=MemoryResponse)
def freeze_memory(memory_id: str, req: MemoryStatusRequest) -> MemoryResponse:
    updated = memory_service.freeze_memory(user_id=req.user_id, agent_id=req.agent_id, memory_id=memory_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="memory not found")
    return MemoryResponse(
        id=updated.id,
        user_id=updated.user_id,
        agent_id=updated.agent_id,
        subject=updated.subject,
        memory_type=updated.memory_type,
        content=updated.content,
        confidence=updated.confidence,
        importance=updated.importance,
        status=updated.status,
        created_at=updated.created_at.isoformat(),
    )


@app.post("/memories/{memory_id}/activate", response_model=MemoryResponse)
def activate_memory(memory_id: str, req: MemoryStatusRequest) -> MemoryResponse:
    updated = memory_service.activate_memory(user_id=req.user_id, agent_id=req.agent_id, memory_id=memory_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="memory not found")
    return MemoryResponse(
        id=updated.id,
        user_id=updated.user_id,
        agent_id=updated.agent_id,
        subject=updated.subject,
        memory_type=updated.memory_type,
        content=updated.content,
        confidence=updated.confidence,
        importance=updated.importance,
        status=updated.status,
        created_at=updated.created_at.isoformat(),
    )


@app.delete("/memories/{memory_id}", response_model=MemoryResponse)
def delete_memory(memory_id: str, req: MemoryStatusRequest) -> MemoryResponse:
    updated = memory_service.delete_memory(user_id=req.user_id, agent_id=req.agent_id, memory_id=memory_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="memory not found")
    return MemoryResponse(
        id=updated.id,
        user_id=updated.user_id,
        agent_id=updated.agent_id,
        subject=updated.subject,
        memory_type=updated.memory_type,
        content=updated.content,
        confidence=updated.confidence,
        importance=updated.importance,
        status=updated.status,
        created_at=updated.created_at.isoformat(),
    )


@app.post("/tasks/confirm", response_model=TaskResponse)
def confirm_task(req: TaskConfirmRequest) -> TaskResponse:
    draft = TaskDraft(
        title=req.title,
        priority=req.priority,
        deadline=req.deadline,
        subtasks=req.subtasks,
    )
    task = task_service.confirm_create(
        user_id=req.user_id,
        draft=draft,
        source_message=req.source_message,
    )
    return TaskResponse(
        id=task.id,
        user_id=task.user_id,
        title=task.title,
        status=task.status,
        priority=task.priority,
        deadline=task.deadline,
        subtasks=task.subtasks,
        source_message=task.source_message,
        created_at=task.created_at.isoformat(),
    )


@app.get("/tasks", response_model=list[TaskResponse])
def list_tasks(user_id: str) -> list[TaskResponse]:
    tasks = task_service.list_tasks(user_id=user_id)
    return [
        TaskResponse(
            id=task.id,
            user_id=task.user_id,
            title=task.title,
            status=task.status,
            priority=task.priority,
            deadline=task.deadline,
            subtasks=task.subtasks,
            source_message=task.source_message,
            created_at=task.created_at.isoformat(),
        )
        for task in tasks
    ]


def _seed_agent_profile_memories(agent_id: str) -> None:
    profile = agent_service.get_agent(agent_id)
    if profile is None:
        return

    try:
        memory_service.initialize_agent_profile_memories(profile)
    except Exception as exc:
        print(f"[memory] failed to seed profile memories for {agent_id}: {exc}", flush=True)


def _check_postgres(enabled: bool, dsn: str) -> InfraTargetStatus:
    if not enabled:
        return InfraTargetStatus(
            enabled=False,
            configured=bool(dsn),
            reachable=False,
            detail="skipped (MEMORY_REPOSITORY != postgres)",
        )

    if not dsn:
        return InfraTargetStatus(
            enabled=True,
            configured=False,
            reachable=False,
            detail="POSTGRES_DSN is empty",
        )

    parsed = urlparse(dsn)
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432

    try:
        with socket.create_connection((host, port), timeout=2):
            pass
    except OSError as exc:
        return InfraTargetStatus(
            enabled=True,
            configured=True,
            reachable=False,
            detail=f"tcp check failed: {exc}",
        )

    return InfraTargetStatus(
        enabled=True,
        configured=True,
        reachable=True,
        detail=f"tcp check ok: {host}:{port}",
    )


def _check_qdrant(enabled: bool, qdrant_url: str) -> InfraTargetStatus:
    if not enabled:
        return InfraTargetStatus(
            enabled=False,
            configured=bool(qdrant_url),
            reachable=False,
            detail="skipped (MEMORY_VECTOR != qdrant)",
        )

    if not qdrant_url:
        return InfraTargetStatus(
            enabled=True,
            configured=False,
            reachable=False,
            detail="QDRANT_URL is empty",
        )

    healthz = qdrant_url.rstrip("/") + "/healthz"
    try:
        with urlopen(healthz, timeout=3) as response:  # noqa: S310
            ok = response.status == 200
    except Exception as exc:
        return InfraTargetStatus(
            enabled=True,
            configured=True,
            reachable=False,
            detail=f"http check failed: {exc}",
        )

    return InfraTargetStatus(
        enabled=True,
        configured=True,
        reachable=ok,
        detail=f"http check status: {200 if ok else 'non-200'}",
    )


def _get_env(key: str, default: str) -> str:
    value = os.getenv(key)
    if value:
        return value

    dotenv_path = Path(__file__).resolve().parents[1] / ".env"
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
