"""Owner-only explicit finalized-transcript translation."""

import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request

from app.core.errors import AppError, ErrorCode
from app.models.ids import DocId
from app.schemas.ai import AIRequest
from app.security.auth import VerifiedUser, require_auth
from app.services.translation.jobs import source_for
from app.services.translation.router import unavailable

router = APIRouter(prefix="/api/v1")
User = Annotated[VerifiedUser, Depends(require_auth)]
Language = Literal["kn", "ta", "hi", "en"]


class TranslateRequest(AIRequest):
    target_lang: Language
    polish: bool = False


@router.post("/translate", status_code=202)
async def translate(payload: TranslateRequest, request: Request, user: User) -> Any:
    state = request.app.state
    sessions = await state.translation_jobs.sessions(
        payload.session_ids, user.uid, payload.event_id
    )
    if any(s["status"] != "finalized" for s in sessions):
        raise AppError(ErrorCode.transcript_incomplete, "Session is not finalized.")
    pairs = set()
    for session in sessions:
        for chunk in await state.store.chunks(session["id"]):
            source = source_for(chunk)
            if (
                chunk["status"] == "done"
                and not chunk["no_speech"]
                and chunk["raw_text"]
                and source
                and source != payload.target_lang
            ):
                pairs.add(source)
    available = [await state.translation_router.can_serve(s, payload.target_lang) for s in pairs]
    if pairs and not any(available):
        raise unavailable()
    return await state.translation_jobs.submit(
        "text", user.uid, payload.model_dump(), request.state.request_id
    )


@router.get("/translation/jobs/{job_id}")
async def job(job_id: DocId, request: Request, user: User) -> Any:
    rows = await request.app.state.store.rows(
        "SELECT * FROM translation_jobs WHERE id=? AND owner_uid=?", (job_id, user.uid)
    )
    if not rows:
        raise AppError(ErrorCode.not_found, "Job not found.")
    row = rows[0]
    return {
        "job_id": row["id"],
        "status": row["status"],
        "error_code": row["error_code"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
    }


@router.get("/sessions/{session_id}/translations")
async def translations(
    session_id: DocId, target_lang: Language, request: Request, user: User
) -> Any:
    session = await request.app.state.store.session(session_id)
    if not session or session["owner_uid"] != user.uid:
        raise AppError(ErrorCode.not_found, "Session not found.")
    rows = await request.app.state.store.rows(
        "SELECT sequence,source_lang,text,engine,model,created_at,polished_text,polish_provider,"
        "polish_model,polished_at,error_code FROM translations "
        "WHERE session_id=? AND target_lang=? ORDER BY sequence",
        (session_id, target_lang),
    )
    return {"session_id": session_id, "target_lang": target_lang, "chunks": rows}


@router.get("/translation/status")
async def status(request: Request, user: User) -> Any:
    return await request.app.state.translation_router.refresh()
