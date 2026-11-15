"""Owner-scoped session lifecycle and streaming multipart queue admission."""

import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from starlette.responses import JSONResponse

from app.core.errors import AppError, ErrorCode
from app.core.request_context import chunk_id_var, session_id_var
from app.models.ids import DocId, validate_doc_id
from app.models.languages import validate_language
from app.schemas.sessions import (
    ChunkOut,
    FinalizeRequest,
    LanguageRequest,
    SessionCreate,
    SessionOut,
)
from app.security.auth import VerifiedUser
from app.security.ownership import require_event_owner, require_owner
from app.security.rate_limit import authenticated_user
from app.services.language import LanguageTracker
from app.services.store import event_in, insert, update, utc_now
from app.workers.transcription_worker import missing_sequences

router = APIRouter(prefix="/api/v1/sessions")
User = Annotated[VerifiedUser, Depends(authenticated_user)]


async def owned(state: Any, session_id: str, user: VerifiedUser) -> dict[str, Any]:
    validate_doc_id(session_id, "session_id")
    session_id_var.set(session_id)
    session = await state.store.session(session_id)
    require_owner(session["owner_uid"] if session else None, user)
    return session


def chunk_out(chunk: dict[str, Any]) -> ChunkOut:
    return ChunkOut(**{**chunk, "segments": json.loads(chunk["segments_json"] or "[]")})


async def session_out(
    state: Any, session_id: str, after_sequence: int = -1, limit: int = 500
) -> SessionOut:
    session = await state.store.session(session_id)
    chunks = await state.store.chunks(session_id)
    counts = {
        status: sum(c["status"] == status for c in chunks)
        for status in ("queued", "processing", "done", "failed")
    }
    counts["total"] = len(chunks)
    language_segments: list[dict[str, Any]] = []
    for chunk in chunks:
        language = chunk["detected_language"]
        if chunk["status"] != "done" or not language:
            continue
        if language_segments and language_segments[-1]["language"] == language:
            language_segments[-1]["to_sequence"] = chunk["sequence"]
        else:
            language_segments.append(
                {
                    "language": language,
                    "from_sequence": chunk["sequence"],
                    "to_sequence": chunk["sequence"],
                }
            )
    events = await state.store.rows(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM session_events WHERE session_id=?", (session_id,)
    )
    tracker = json.loads(session["tracker_state"])
    return SessionOut(
        session_id=session_id,
        event_id=session["event_id"],
        status=session["status"],
        transcript_status=session["transcript_status"],
        model_profile=session["model_profile"],
        model_name=session["model_name"],
        language={
            "mode": session["language_mode"],
            "locked": tracker.get("locked"),
            "segments": language_segments,
        },
        counts=counts,
        missing_sequences=missing_sequences(session, chunks),
        chunks=[chunk_out(c) for c in chunks if c["sequence"] > after_sequence][:limit],
        transcript_text=" ".join(
            c["raw_text"] for c in chunks if c["status"] == "done" and c["raw_text"]
        )
        if after_sequence == -1
        else None,
        last_event_seq=events[0]["seq"],
        firestore_sync=session["firestore_sync"],
    )


@router.post("")
async def create(body: SessionCreate, request: Request, user: User) -> JSONResponse:
    state, settings = request.app.state, request.app.state.settings
    mode = validate_language(body.language_mode, settings, allow_auto=True)
    expected = list(
        dict.fromkeys(validate_language(code, settings) for code in body.expected_languages)
    )
    if body.overlap_ms > settings.max_overlap_ms:
        raise AppError(ErrorCode.validation_error, "Overlap exceeds configured maximum.")
    session_id_var.set(body.session_id)
    async with state.store.mutation_lock:
        existing = await state.store.session(body.session_id)
        if existing:
            require_owner(existing["owner_uid"], user)
            if existing["event_id"] != body.event_id:
                raise AppError(ErrorCode.not_found, "Session not found.")
            return JSONResponse(
                (await session_out(state, body.session_id)).model_dump(mode="json"), status_code=200
            )
        await require_event_owner(body.event_id, user, state.event_repository)
        now = utc_now()
        session = {
            "id": body.session_id,
            "owner_uid": user.uid,
            "event_id": body.event_id,
            "status": "active",
            "transcript_status": "pending",
            "model_profile": body.model_profile,
            "model_name": state.model_manager.name(body.model_profile),
            "language_mode": mode,
            "expected_languages": json.dumps(expected),
            "overlap_ms": body.overlap_ms,
            "tracker_state": json.dumps(LanguageTracker(settings, mode, expected).to_state()),
            "firestore_sync": "pending" if state.firestore_sync.enabled else "disabled",
            "created_at": now,
            "updated_at": now,
        }

        def save(conn: sqlite3.Connection) -> dict[str, Any]:
            insert(conn, "sessions", session)
            return event_in(conn, body.session_id, "session_created", {"event_id": body.event_id})

        message = await state.store.transaction(save)
        state.broadcaster.publish(body.session_id, message)
        await state.store.audit("session_created", body.session_id, uid=user.uid)
    # Never block session creation on Firestore (it may be offline at the event). The
    # background write is retried by the worker's sync sweep if it fails.
    state.worker.schedule_sync(body.session_id)
    return JSONResponse(
        (await session_out(state, body.session_id)).model_dump(mode="json"), status_code=201
    )


@router.post("/{session_id}/chunks")
async def upload(
    session_id: DocId,
    request: Request,
    user: User,
    chunk_id: Annotated[DocId, Form()],
    sequence: Annotated[int, Form(ge=0, le=100000)],
    start_ms: Annotated[int, Form(ge=0)],
    end_ms: Annotated[int, Form(ge=1)],
    overlap_ms: Annotated[int, Form(ge=0)],
    file: Annotated[UploadFile, File()],
    continues: Annotated[bool, Form()] = True,
    language: Annotated[str | None, Form()] = None,
    sha256: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    state, settings = request.app.state, request.app.state.settings
    session = await owned(state, session_id, user)
    if session["status"] == "finalized":
        raise AppError(ErrorCode.session_finalized, "Session is finalized.")
    chunk_id_var.set(chunk_id)
    if language is not None:
        language = validate_language(language, settings)
    if (
        end_ms <= start_ms
        or end_ms - start_ms > settings.max_chunk_duration_s * 1000 + overlap_ms
        or overlap_ms > settings.max_overlap_ms
    ):
        raise AppError(ErrorCode.validation_error, "Invalid chunk timing or overlap.")
    if sha256 is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise AppError(ErrorCode.validation_error, "Invalid checksum format.")
    extension = Path(file.filename or "").suffix.lower().lstrip(".")
    if extension not in settings.allowed_audio_extensions:
        raise AppError(ErrorCode.unsupported_media_type, "Audio extension is not supported.")
    filename = f"{sequence:06d}_{chunk_id}.{extension}"
    directory = state.store.audio_dir / session_id
    temporary = directory / (filename + ".part")
    async with state.store.mutation_lock:
        session = await owned(state, session_id, user)
        if session["status"] == "finalized":
            raise AppError(ErrorCode.session_finalized, "Session is finalized.")

        def persist_temp() -> tuple[str, int]:
            directory.mkdir(parents=True, exist_ok=True)
            digest, size = hashlib.sha256(), 0
            with temporary.open("wb") as output:
                while block := file.file.read(65536):
                    size += len(block)
                    if size > settings.max_chunk_upload_bytes:
                        raise AppError(ErrorCode.payload_too_large, "Audio upload is too large.")
                    digest.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            return digest.hexdigest(), size

        try:
            digest, size = await asyncio.to_thread(persist_temp)
            chunks = await state.store.chunks(session_id)
            for chunk in chunks:
                if chunk["chunk_id"] == chunk_id:
                    if chunk["sha256"] == digest:
                        return JSONResponse(
                            {
                                "duplicate": True,
                                "status": chunk["status"],
                                "chunk": chunk_out(chunk).model_dump(mode="json"),
                            }
                        )
                    raise AppError(
                        ErrorCode.chunk_conflict, "Chunk content conflicts with an existing upload."
                    )
                if chunk["sequence"] == sequence:
                    raise AppError(ErrorCode.chunk_conflict, "Sequence is already assigned.")
            if sha256 is not None and digest != sha256.lower():
                raise AppError(ErrorCode.checksum_mismatch, "Audio checksum does not match.")
            depth = await state.store.queue_depth()
            if depth >= settings.queue_max_depth:
                raise AppError(
                    ErrorCode.queue_full,
                    "Transcription queue is full.",
                    headers={"Retry-After": "10"},
                )
            await asyncio.to_thread(os.replace, temporary, directory / filename)
            now = utc_now()
            chunk = {
                "session_id": session_id,
                "chunk_id": chunk_id,
                "sequence": sequence,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "overlap_ms": overlap_ms,
                "continues": int(continues),
                "file_name": filename,
                "sha256": digest,
                "size_bytes": size,
                "content_type": file.content_type,
                "status": "queued",
                "language_requested": language,
                "created_at": now,
                "updated_at": now,
            }

            def save(conn: sqlite3.Connection) -> dict[str, Any]:
                insert(conn, "chunks", chunk)
                return event_in(
                    conn, session_id, "chunk_queued", {"chunk_id": chunk_id, "sequence": sequence}
                )

            message = await state.store.transaction(save)
            state.broadcaster.publish(session_id, message)
            await state.store.audit("chunk_uploaded", session_id, chunk_id, uid=user.uid)
            state.server_state.queue_depth = depth + 1
        finally:
            await asyncio.to_thread(temporary.unlink, missing_ok=True)
    state.worker.notify()
    await state.worker.maybe_finalize(session_id)
    return JSONResponse(
        {
            "chunk_id": chunk_id,
            "sequence": sequence,
            "status": "queued",
            "duplicate": False,
            "queue_depth": depth + 1,
        },
        status_code=202,
    )


@router.get("/{session_id}", response_model=SessionOut)
async def get_session(
    session_id: DocId,
    request: Request,
    user: User,
    after_sequence: int = Query(-1, ge=-1),
    limit: int = Query(500, ge=1, le=1000),
) -> SessionOut:
    await owned(request.app.state, session_id, user)
    return await session_out(request.app.state, session_id, after_sequence, limit)


@router.post("/{session_id}/finalize")
async def finalize(
    session_id: DocId, body: FinalizeRequest, request: Request, user: User
) -> JSONResponse:
    state = request.app.state
    async with state.store.mutation_lock:
        session = await owned(state, session_id, user)
        if session["status"] != "finalized":

            def save(conn: sqlite3.Connection) -> dict[str, Any] | None:
                update(
                    conn,
                    "sessions",
                    {
                        "status": "finalizing",
                        "expected_chunk_count": body.expected_chunk_count
                        if body.expected_chunk_count is not None
                        else session["expected_chunk_count"],
                        "force_finalize": int(body.force or session["force_finalize"]),
                        "updated_at": utc_now(),
                    },
                    "id=?",
                    (session_id,),
                )
                return (
                    event_in(conn, session_id, "session_finalizing", {})
                    if session["status"] != "finalizing"
                    else None
                )

            message = await state.store.transaction(save)
            if message:
                state.broadcaster.publish(session_id, message)
    await state.worker.maybe_finalize(session_id)
    state.worker.notify()
    result = await session_out(state, session_id)
    if result.status == "finalized":
        return JSONResponse(result.model_dump(mode="json"))
    return JSONResponse(
        {
            "status": "finalizing",
            "missing_sequences": result.missing_sequences,
            "pending": result.counts["queued"] + result.counts["processing"],
        },
        status_code=202,
    )


async def change_language(
    state: Any, session_id: str, language: str, user: VerifiedUser
) -> dict[str, Any]:
    language = validate_language(language, state.settings, allow_auto=True)
    await owned(state, session_id, user)
    async with state.worker.session_lock(session_id):
        async with state.store.mutation_lock:
            session = await owned(state, session_id, user)
            if session["status"] == "finalized":
                raise AppError(ErrorCode.session_finalized, "Session is finalized.")
            tracker = LanguageTracker.from_state(
                json.loads(session["tracker_state"]), state.settings
            )
            tracker.set_mode(language)

            def save(conn: sqlite3.Connection) -> dict[str, Any]:
                update(
                    conn,
                    "sessions",
                    {
                        "language_mode": language,
                        "tracker_state": json.dumps(tracker.to_state()),
                        "updated_at": utc_now(),
                    },
                    "id=?",
                    (session_id,),
                )
                return event_in(
                    conn, session_id, "language_override", {"language": language, "by": "user"}
                )

            message = await state.store.transaction(save)
            state.broadcaster.publish(session_id, message)
            await state.store.audit("language_override", session_id, uid=user.uid)
    return (await session_out(state, session_id)).language


@router.post("/{session_id}/language")
async def override(
    session_id: DocId, body: LanguageRequest, request: Request, user: User
) -> dict[str, Any]:
    return await change_language(request.app.state, session_id, body.language, user)


@router.delete("/{session_id}")
async def delete(session_id: DocId, request: Request, user: User) -> dict[str, Any]:
    state = request.app.state
    await owned(state, session_id, user)
    if any(c["status"] == "processing" for c in await state.store.chunks(session_id)):
        raise AppError(ErrorCode.session_busy, "Session has an in-flight chunk.")
    async with state.worker.session_lock(session_id):
        async with state.store.mutation_lock:
            session = await owned(state, session_id, user)
            if any(c["status"] == "processing" for c in await state.store.chunks(session_id)):
                raise AppError(ErrorCode.session_busy, "Session has an in-flight chunk.")
            message = await state.store.transaction(
                lambda conn: event_in(conn, session_id, "session_deleted", {})
            )
            state.broadcaster.publish(session_id, message)
            await asyncio.to_thread(shutil.rmtree, state.store.audio_dir / session_id, True)
            await state.store.execute("DELETE FROM sessions WHERE id=?", (session_id,))
            await state.store.audit("session_deleted", session_id, uid=user.uid)
            state.server_state.queue_depth = await state.store.queue_depth()
        deleted = False
        if state.firestore_sync.enabled:
            try:
                await state.firestore_sync.delete_session(session["event_id"], session_id)
                deleted = True
            except Exception:
                deleted = False
    state.worker.session_locks.pop(session_id, None)
    return {"deleted": True, "firestore_deleted": deleted}
