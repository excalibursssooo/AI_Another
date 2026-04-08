from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
import os
from pathlib import Path
from pydantic import BaseModel, Field
import socket
from starlette.responses import StreamingResponse
from typing import Any, Iterator
from urllib.parse import urlparse
from urllib.request import urlopen

from core.agents.service import AgentAICreationError, AgentService
from core.emotion.service import EmotionService
from core.memory.models import MemoryItem
from core.memory.models import MemoryCandidate
from core.memory.service import MemoryService
from core.safety.service import SafetyService
from core.posts.generator import FeedGenerationUnavailableError, FeedGenerator
from core.posts.models import FeedPost
from core.posts.service import FeedService
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
feed_service = FeedService.build_from_env()
feed_generator = FeedGenerator.build_from_env()
orchestrator = SessionOrchestrator(
    memory_service=memory_service,
    safety_service=safety_service,
    reply_generator=reply_generator,
    conversation_store=conversation_store,
)

_feed_scheduler_task: asyncio.Task[None] | None = None
_last_feed_generated_at: dict[tuple[str, str], datetime] = {}


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
    mood_intensity: float
    heartbeat_bpm: int
    risk_level: str
    recalled_memories: list[dict[str, str]]
    persisted_memory_count: int


class AgentLiveStateResponse(BaseModel):
    agent_id: str
    agent_name: str
    mood_label: str
    mood_intensity: float
    mood_index: int
    heartbeat_bpm: int
    heartbeat_interval_ms: int
    stress_level: float
    trend: str
    risk_level: str
    updated_at: str


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
    openrouter_api_key_present: bool
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
    conflict_state: str
    created_at: str
    access_count: int
    last_accessed_at: str | None


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


class MemoryCompactResponse(BaseModel):
    total: int
    deleted_count: int
    deleted_ids: list[str]


class MemoryRecallDebugRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    agent_id: str = Field(default="default", min_length=1)
    query_text: str | None = Field(default=None, max_length=4000)
    limit: int = Field(default=5, ge=1, le=50)


class MemoryRecallScoreItem(BaseModel):
    rank: int
    memory_id: str
    user_id: str
    agent_id: str
    subject: str
    memory_type: str
    content: str
    status: str
    conflict_state: str
    semantic_score: float
    importance_score: float
    freshness_score: float
    stability_score: float
    conflict_factor: float
    final_score: float


class MemoryRecallDebugResponse(BaseModel):
    query_text: str
    items: list[MemoryRecallScoreItem]


class MemoryRecallWeights(BaseModel):
    semantic: float
    importance: float
    freshness: float
    stability: float
    conflict: float


class MemoryRecallWeightsUpdateRequest(BaseModel):
    semantic: float = Field(..., ge=0.0, le=10.0)
    importance: float = Field(..., ge=0.0, le=10.0)
    freshness: float = Field(..., ge=0.0, le=10.0)
    stability: float = Field(..., ge=0.0, le=10.0)
    conflict: float = Field(..., ge=0.0, le=10.0)


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


class PostResponse(BaseModel):
    id: str
    user_id: str
    agent_id: str
    agent_name: str
    content: str
    topic_seed: str
    post_type: str
    status: str
    source_task_id: str | None
    created_at: str


class PostListResponse(BaseModel):
    items: list[PostResponse]
    total: int
    limit: int
    offset: int


class GeneratePostRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    source_task_id: str | None = Field(default=None, max_length=120)


class GeneratePostResponse(BaseModel):
    skipped: bool
    reason: str
    post: PostResponse | None


class TriggerChatResponse(BaseModel):
    post_id: str
    user_id: str
    agent_id: str
    suggested_message: str


@app.on_event("startup")
async def on_startup() -> None:
    global _feed_scheduler_task
    if _is_feed_scheduler_enabled():
        _feed_scheduler_task = asyncio.create_task(_run_feed_scheduler())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _feed_scheduler_task
    if _feed_scheduler_task is None:
        return
    _feed_scheduler_task.cancel()
    try:
        await _feed_scheduler_task
    except asyncio.CancelledError:
        pass
    _feed_scheduler_task = None


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
_agent_live_states: dict[tuple[str, str], dict[str, object]] = {}


def _append_telemetry(buffer: list[dict[str, object]], payload: dict[str, object]) -> None:
    buffer.append(payload)
    if len(buffer) > MAX_TELEMETRY_ITEMS:
        del buffer[0 : len(buffer) - MAX_TELEMETRY_ITEMS]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _derive_stress_level(mood_label: str, mood_intensity: float, risk_level: str) -> float:
    base = 0.25 * mood_intensity
    if mood_label in {"anxious", "angry", "sad"}:
        base += 0.45 * mood_intensity
    if risk_level in {"medium", "high"}:
        base += 0.2
    return max(0.0, min(1.0, base))


def _update_agent_live_state(
    *,
    user_id: str,
    agent_id: str,
    agent_name: str,
    mood_label: str,
    mood_intensity: float,
    heartbeat_bpm: int,
    risk_level: str,
) -> dict[str, object]:
    key = (user_id, agent_id)
    previous = _agent_live_states.get(key)

    mood = max(0.0, min(1.0, mood_intensity))
    bpm = max(55, min(130, int(heartbeat_bpm)))
    mood_index = int(round(mood * 100))
    stress_level = _derive_stress_level(mood_label=mood_label, mood_intensity=mood, risk_level=risk_level)

    trend = "steady"
    if previous is not None:
        old_index = _to_int(previous.get("mood_index", mood_index), mood_index)
        if mood_index >= old_index + 6:
            trend = "up"
        elif mood_index <= old_index - 6:
            trend = "down"

    state = {
        "agent_id": agent_id,
        "agent_name": agent_name,
        "mood_label": mood_label,
        "mood_intensity": mood,
        "mood_index": mood_index,
        "heartbeat_bpm": bpm,
        "heartbeat_interval_ms": int(60_000 / max(1, bpm)),
        "stress_level": stress_level,
        "trend": trend,
        "risk_level": risk_level,
        "updated_at": _now_iso(),
    }
    _agent_live_states[key] = state
    return state


def _get_agent_live_state(user_id: str, agent_id: str, agent_name: str) -> dict[str, object]:
    state = _agent_live_states.get((user_id, agent_id))
    if state is not None:
        return state
    return {
        "agent_id": agent_id,
        "agent_name": agent_name,
        "mood_label": "calm",
        "mood_intensity": 0.35,
        "mood_index": 35,
        "heartbeat_bpm": 72,
        "heartbeat_interval_ms": int(60_000 / 72),
        "stress_level": 0.2,
        "trend": "steady",
        "risk_level": "low",
        "updated_at": _now_iso(),
    }


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
            if event.get("type") == "done":
                _update_agent_live_state(
                    user_id=req.user_id,
                    agent_id=str(event.get("agent_id", req.agent_id)),
                    agent_name=str(event.get("agent_name", selected_agent.display_name or selected_agent.name)),
                    mood_label=str(event.get("emotion_label", "calm")),
                    mood_intensity=_to_float(event.get("mood_intensity", 0.35), 0.35),
                    heartbeat_bpm=_to_int(event.get("heartbeat_bpm", 72), 72),
                    risk_level=str(event.get("risk_level", "low")),
                )
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/agents/{agent_id}/state/live", response_model=AgentLiveStateResponse)
def get_agent_live_state(agent_id: str, user_id: str) -> AgentLiveStateResponse:
    selected_agent = agent_service.get_agent(agent_id)
    if selected_agent is None:
        raise HTTPException(status_code=404, detail="agent not found")

    state = _get_agent_live_state(
        user_id=user_id,
        agent_id=agent_id,
        agent_name=selected_agent.display_name or selected_agent.name,
    )
    return AgentLiveStateResponse(
        agent_id=str(state["agent_id"]),
        agent_name=str(state["agent_name"]),
        mood_label=str(state["mood_label"]),
        mood_intensity=_to_float(state["mood_intensity"], 0.35),
        mood_index=_to_int(state["mood_index"], 35),
        heartbeat_bpm=_to_int(state["heartbeat_bpm"], 72),
        heartbeat_interval_ms=_to_int(state["heartbeat_interval_ms"], int(60_000 / 72)),
        stress_level=_to_float(state["stress_level"], 0.2),
        trend=str(state["trend"]),
        risk_level=str(state["risk_level"]),
        updated_at=str(state["updated_at"]),
    )


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
        existing_count=_to_int(debug.get("existing_count", 0), 0),
        used_fallback=bool(debug.get("used_fallback", False)),
        extraction_backend=str(extraction_debug.get("backend", "unknown")),
        extraction_model=str(extraction_debug.get("model", "unknown")),
        extraction_is_llm=bool(extraction_debug.get("is_llm", False)),
        extraction_reason=str(extraction_debug.get("reason", "")),
        raw_text=str(extraction_debug.get("raw_text", "")),
        candidate_count=_to_int(debug.get("candidate_count", 0), 0),
        persisted_count=_to_int(debug.get("persisted_count", 0), 0),
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
    emotion_backend = _get_env("EMOTION_BACKEND", "openrouter")
    emotion_model = _get_env("EMOTION_MODEL_NAME", "openai/gpt-5.2")
    openrouter_api_key = _get_env("OPENROUTER_API_KEY", "")

    postgres_dsn = _get_env("POSTGRES_DSN", "")
    postgres_status = _check_postgres(memory_repository == "postgres", postgres_dsn)

    qdrant_url = _get_env("QDRANT_URL", "http://localhost:6333")
    qdrant_status = _check_qdrant(memory_vector == "qdrant", qdrant_url)

    return InfraDebugResponse(
        memory_repository=memory_repository,
        memory_vector=memory_vector,
        emotion_backend=emotion_backend,
        emotion_model=emotion_model,
        openrouter_api_key_present=bool(openrouter_api_key),
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
            conflict_state=item.conflict_state,
            created_at=item.created_at.isoformat(),
            access_count=item.access_count,
            last_accessed_at=item.last_accessed_at.isoformat() if item.last_accessed_at else None,
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
        conflict_state=updated.conflict_state,
        created_at=updated.created_at.isoformat(),
        access_count=updated.access_count,
        last_accessed_at=updated.last_accessed_at.isoformat() if updated.last_accessed_at else None,
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
        conflict_state=updated.conflict_state,
        created_at=updated.created_at.isoformat(),
        access_count=updated.access_count,
        last_accessed_at=updated.last_accessed_at.isoformat() if updated.last_accessed_at else None,
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
        conflict_state=updated.conflict_state,
        created_at=updated.created_at.isoformat(),
        access_count=updated.access_count,
        last_accessed_at=updated.last_accessed_at.isoformat() if updated.last_accessed_at else None,
    )


@app.post("/memories/compact", response_model=MemoryCompactResponse)
def compact_memories(req: MemoryStatusRequest) -> MemoryCompactResponse:
    result = memory_service.compact_similar_memories(user_id=req.user_id, agent_id=req.agent_id)
    deleted_ids_obj = result.get("deleted_ids", [])
    deleted_ids = deleted_ids_obj if isinstance(deleted_ids_obj, list) else []
    return MemoryCompactResponse(
        total=_to_int(result.get("total", 0), 0),
        deleted_count=_to_int(result.get("deleted_count", 0), 0),
        deleted_ids=[str(item) for item in deleted_ids if isinstance(item, str)],
    )


@app.post("/memories/recall/debug", response_model=MemoryRecallDebugResponse)
def debug_memory_recall(req: MemoryRecallDebugRequest) -> MemoryRecallDebugResponse:
    scored = memory_service.debug_retrieval_scores(
        user_id=req.user_id,
        agent_id=req.agent_id,
        query_text=req.query_text,
        limit=req.limit,
    )

    items: list[MemoryRecallScoreItem] = []
    for entry in scored:
        memory_obj = entry.get("memory")
        if not isinstance(memory_obj, MemoryItem):
            continue
        items.append(
            MemoryRecallScoreItem(
                rank=_to_int(entry.get("rank", 0), 0),
                memory_id=memory_obj.id,
                user_id=memory_obj.user_id,
                agent_id=memory_obj.agent_id,
                subject=memory_obj.subject,
                memory_type=memory_obj.memory_type,
                content=memory_obj.content,
                status=memory_obj.status,
                conflict_state=memory_obj.conflict_state,
                semantic_score=_to_float(entry.get("semantic_score", 0.0), 0.0),
                importance_score=_to_float(entry.get("importance_score", 0.0), 0.0),
                freshness_score=_to_float(entry.get("freshness_score", 0.0), 0.0),
                stability_score=_to_float(entry.get("stability_score", 0.0), 0.0),
                conflict_factor=_to_float(entry.get("conflict_factor", 0.0), 0.0),
                final_score=_to_float(entry.get("final_score", 0.0), 0.0),
            ),
        )

    return MemoryRecallDebugResponse(
        query_text=req.query_text or "",
        items=items,
    )


@app.get("/memories/recall/weights", response_model=MemoryRecallWeights)
def get_memory_recall_weights() -> MemoryRecallWeights:
    weights = memory_service.get_retrieval_weights()
    return MemoryRecallWeights(
        semantic=weights.semantic,
        importance=weights.importance,
        freshness=weights.freshness,
        stability=weights.stability,
        conflict=weights.conflict,
    )


@app.post("/memories/recall/weights", response_model=MemoryRecallWeights)
def update_memory_recall_weights(req: MemoryRecallWeightsUpdateRequest) -> MemoryRecallWeights:
    total = req.semantic + req.importance + req.freshness + req.stability + req.conflict
    if total <= 0:
        raise HTTPException(status_code=400, detail="at least one weight must be greater than 0")

    updated = memory_service.update_retrieval_weights(
        semantic=req.semantic,
        importance=req.importance,
        freshness=req.freshness,
        stability=req.stability,
        conflict=req.conflict,
    )
    return MemoryRecallWeights(
        semantic=updated.semantic,
        importance=updated.importance,
        freshness=updated.freshness,
        stability=updated.stability,
        conflict=updated.conflict,
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


@app.get("/posts", response_model=PostListResponse)
def list_posts(user_id: str, limit: int = 20, offset: int = 0, include_archived: bool = False) -> PostListResponse:
    listed = feed_service.list_posts(
        user_id=user_id,
        limit=limit,
        offset=offset,
        include_archived=include_archived,
    )
    return PostListResponse(
        items=[_build_post_response(item) for item in listed.items],
        total=listed.total,
        limit=listed.limit,
        offset=listed.offset,
    )


@app.post("/agents/{agent_id}/generate-post", response_model=GeneratePostResponse)
def generate_post(agent_id: str, req: GeneratePostRequest) -> GeneratePostResponse:
    profile = agent_service.get_agent(agent_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="agent not found")
    if profile.status != "active":
        raise HTTPException(status_code=400, detail="agent is not active")

    try:
        published = _generate_and_publish_post(
            user_id=req.user_id,
            agent_id=profile.id,
            source_task_id=req.source_task_id,
        )
    except FeedGenerationUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return GeneratePostResponse(
        skipped=published.skipped,
        reason=published.reason,
        post=_build_post_response(published.post) if published.post is not None else None,
    )


@app.post("/posts/{post_id}/trigger-chat", response_model=TriggerChatResponse)
def trigger_chat_from_post(post_id: str, user_id: str) -> TriggerChatResponse:
    post = feed_service.get_post(user_id=user_id, post_id=post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="post not found")

    return TriggerChatResponse(
        post_id=post.id,
        user_id=user_id,
        agent_id=post.agent_id,
        suggested_message=post.topic_seed,
    )


def _seed_agent_profile_memories(agent_id: str) -> None:
    profile = agent_service.get_agent(agent_id)
    if profile is None:
        return

    try:
        memory_service.initialize_agent_profile_memories(profile)
    except Exception as exc:
        print(f"[memory] failed to seed profile memories for {agent_id}: {exc}", flush=True)


def _build_post_response(post: FeedPost) -> PostResponse:
    profile = agent_service.get_agent(post.agent_id)
    agent_name = post.agent_id
    if profile is not None:
        agent_name = profile.display_name or profile.name

    return PostResponse(
        id=post.id,
        user_id=post.user_id,
        agent_id=post.agent_id,
        agent_name=agent_name,
        content=post.content,
        topic_seed=post.topic_seed,
        post_type=post.post_type,
        status=post.status,
        source_task_id=post.source_task_id,
        created_at=post.created_at.isoformat(),
    )


def _generate_and_publish_post(
    *,
    user_id: str,
    agent_id: str,
    source_task_id: str | None = None,
):
    profile = agent_service.get_agent(agent_id)
    if profile is None:
        raise FeedGenerationUnavailableError("动态生成失败：agent 不存在。")

    shown_name = profile.display_name or profile.name
    state = _get_agent_live_state(user_id=user_id, agent_id=agent_id, agent_name=shown_name)
    mood_label = str(state.get("mood_label", "calm"))
    mood_intensity = _to_float(state.get("mood_intensity", 0.35), 0.35)

    conversation_key = f"{user_id}:{agent_id}"
    recent_turns = conversation_store.recent(user_id=conversation_key, limit=6)
    generated = feed_generator.generate(
        agent_profile=profile,
        recent_turns=recent_turns,
        mood_label=mood_label,
        mood_intensity=mood_intensity,
    )
    published = feed_service.publish_post(
        user_id=user_id,
        agent_id=agent_id,
        content=generated.content,
        topic_seed=generated.topic_seed,
        post_type=generated.post_type,
        source_task_id=source_task_id,
    )
    _persist_post_as_memory(user_id=user_id, agent_id=agent_id, published=published)
    return published


def _persist_post_as_memory(*, user_id: str, agent_id: str, published: object) -> None:
    post_obj = getattr(published, "post", None)
    skipped = bool(getattr(published, "skipped", False))
    if skipped or post_obj is None:
        return

    post_content = str(getattr(post_obj, "content", "")).strip()
    topic_seed = str(getattr(post_obj, "topic_seed", "")).strip()
    if not post_content:
        return

    memory_text = f"我发布过一条动态：{post_content}"
    if topic_seed:
        memory_text = memory_text + f"。当时我想聊的话题是：{topic_seed}"

    try:
        memory_service.persist_candidates(
            user_id=user_id,
            agent_id=agent_id,
            candidates=[
                MemoryCandidate(
                    subject="agent",
                    memory_type="agent_post",
                    content=memory_text,
                    confidence=0.82,
                    importance=0.68,
                ),
            ],
        )
    except Exception as exc:
        print(f"[feed] failed to persist post memory for {user_id}/{agent_id}: {exc}", flush=True)


def _is_feed_scheduler_enabled() -> bool:
    return _get_env("FEED_GENERATION_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}


def _get_feed_scheduler_interval_seconds() -> int:
    raw = _get_env("FEED_GENERATION_INTERVAL_SECONDS", "300")
    try:
        interval = int(raw)
    except ValueError:
        interval = 300
    return max(30, interval)


def _get_feed_cooldown_seconds() -> int:
    raw = _get_env("FEED_AGENT_COOLDOWN_SECONDS", "1800")
    try:
        cooldown = int(raw)
    except ValueError:
        cooldown = 1800
    return max(0, cooldown)


def _list_known_users_for_feed() -> list[str]:
    return conversation_store.known_user_ids()


def _should_skip_by_cooldown(user_id: str, agent_id: str) -> bool:
    cooldown_seconds = _get_feed_cooldown_seconds()
    if cooldown_seconds <= 0:
        return False

    last_generated_at = _last_feed_generated_at.get((user_id, agent_id))
    if last_generated_at is None:
        return False

    return datetime.now(UTC) - last_generated_at < timedelta(seconds=cooldown_seconds)


def _mark_generated_now(user_id: str, agent_id: str) -> None:
    _last_feed_generated_at[(user_id, agent_id)] = datetime.now(UTC)


async def _run_feed_scheduler() -> None:
    interval = _get_feed_scheduler_interval_seconds()
    await asyncio.sleep(interval)

    while True:
        try:
            users = _list_known_users_for_feed()
            if users:
                active_agents = agent_service.list_agents(include_inactive=False)
                for user_id in users:
                    for agent in active_agents:
                        if _should_skip_by_cooldown(user_id=user_id, agent_id=agent.id):
                            continue
                        try:
                            await asyncio.to_thread(
                                _generate_and_publish_post,
                                user_id=user_id,
                                agent_id=agent.id,
                            )
                            _mark_generated_now(user_id=user_id, agent_id=agent.id)
                        except FeedGenerationUnavailableError as exc:
                            print(f"[feed] generation skipped for {user_id}/{agent.id}: {exc}", flush=True)
        except Exception as exc:
            print(f"[feed] scheduler loop error: {exc}", flush=True)

        await asyncio.sleep(interval)


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
