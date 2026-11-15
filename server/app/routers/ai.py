"""Authenticated, owner-only opt-in jobs. Submission ordering is intentional."""

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request

from app.core.errors import AppError, ErrorCode
from app.models.ids import validate_doc_id
from app.schemas.ai import BriefRequest, CleanupRequest
from app.security.auth import VerifiedUser, require_auth
from app.security.rate_limit import rate_error
from app.services.ai.jobs import event_cloud_access

router = APIRouter(prefix="/api/v1")
User = Annotated[VerifiedUser, Depends(require_auth)]


async def submit(
    request: Request, user: VerifiedUser, payload: CleanupRequest | BriefRequest
) -> Any:
    state = request.app.state
    sessions = await state.ai_jobs.sessions(payload.session_ids, user.uid, payload.event_id)
    allow_cloud = await event_cloud_access(state.event_repository, payload.event_id, user.uid)
    if not allow_cloud and not any(
        p.configured and not p.is_cloud for p in state.ai_router.providers
    ):
        raise AppError(
            ErrorCode.cloud_ai_disabled_for_event, "Cloud AI is disabled for this event."
        )
    if not state.ai_router.usable(allow_cloud):
        raise AppError(
            ErrorCode.provider_unavailable, "Cloud AI unavailable; raw transcript preserved."
        )
    if isinstance(payload, BriefRequest):
        if len(payload.notes) > state.settings.ai_brief_max_notes:
            raise AppError(ErrorCode.validation_error, "Too many owner notes.")
        if not payload.allow_incomplete and any(
            s["status"] != "finalized" or s["transcript_status"] != "complete" for s in sessions
        ):
            raise AppError(ErrorCode.transcript_incomplete, "Transcript is incomplete.")
        kind = "brief"
    else:
        if any(s["status"] != "finalized" for s in sessions):
            raise AppError(ErrorCode.transcript_incomplete, "Session is not finalized.")
        kind = "cleanup"
    decisions = [state.ai_user_limiter.check(user.uid), state.ai_global_limiter.check("global")]
    denied = [d for d in decisions if not d.allowed]
    if denied:
        raise rate_error(max(denied, key=lambda d: d.retry_after_s))
    return await state.ai_jobs.submit(
        kind, user.uid, payload.model_dump(), request.state.request_id
    )


@router.post("/notes/cleanup", status_code=202)
async def cleanup(payload: CleanupRequest, request: Request, user: User) -> Any:
    return await submit(request, user, payload)


@router.post("/briefs", status_code=202)
async def brief(payload: BriefRequest, request: Request, user: User) -> Any:
    return await submit(request, user, payload)


@router.get("/ai/jobs/{job_id}")
async def job(job_id: str, request: Request, user: User) -> Any:
    validate_doc_id(job_id, "job_id")
    rows = await request.app.state.store.rows(
        "SELECT * FROM ai_jobs WHERE id=? AND owner_uid=?", (job_id, user.uid)
    )
    if not rows:
        raise AppError(ErrorCode.not_found, "Job not found.")
    row = rows[0]
    return {
        "job_id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "provider": row["provider"],
        "model": row["model"],
        "error_code": row["error_code"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
    }


@router.get("/sessions/{session_id}/polished")
async def polished(session_id: str, request: Request, user: User) -> Any:
    validate_doc_id(session_id, "session_id")
    session = await request.app.state.store.session(session_id)
    if not session or session["owner_uid"] != user.uid:
        raise AppError(ErrorCode.not_found, "Session not found.")
    return {
        "session_id": session_id,
        "chunks": [
            {key: c[key] for key in ("sequence", "polished_text", "polished_level", "polish_error")}
            for c in await request.app.state.store.chunks(session_id)
        ],
    }


@router.get("/ai/status")
async def status(request: Request, user: User) -> Any:
    ai_router = request.app.state.ai_router
    providers = ai_router.status()
    return {
        "providers": providers,
        "cloud_available": any(
            p.is_cloud and providers[p.name]["status"] in {"ready", "degraded"}
            for p in ai_router.providers
        ),
        "local_available": any(
            not p.is_cloud and providers[p.name]["status"] in {"ready", "degraded"}
            for p in ai_router.providers
        ),
    }


@router.post("/ai/providers/check")
async def check(request: Request, user: User) -> Any:
    return await request.app.state.ai_router.check()
