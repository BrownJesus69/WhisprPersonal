"""Download local, owner-scoped transcripts without invoking AI."""

import re

from fastapi import APIRouter, Request
from starlette.responses import Response

from app.core.errors import AppError, ErrorCode
from app.routers.sessions import User, owned
from app.schemas.export import ExportRequest
from app.services.store import utc_now

router = APIRouter(prefix="/api/v1/export")
LANGUAGES = {"kn": "Kannada", "ta": "Tamil", "hi": "Hindi", "en": "English"}


def timestamp(ms: int) -> str:
    seconds = ms // 1000
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"


@router.post("")
async def export(body: ExportRequest, request: Request, user: User) -> Response:
    state = request.app.state
    lines: list[str] = []
    heading = "# " if body.format == "md" else ""
    # Hold the mutation lock so deletion/restitching cannot change a document mid-read.
    async with state.store.mutation_lock:
        sessions = []
        for session_id in dict.fromkeys(body.session_ids):
            session = await owned(state, session_id, user)
            if session["event_id"] != body.event_id:
                raise AppError(ErrorCode.not_found, "Session not found.")
            sessions.append(session)
        lines.extend([heading + (body.title or body.event_id), f"Exported UTC: {utc_now()}", ""])
        if body.text == "polished":
            lines.extend(["AI-cleaned text; the raw transcript is unchanged on the laptop.", ""])
        for session in sessions:
            lines.extend(
                [
                    ("## " if body.format == "md" else "") + f"Session {session['id']}",
                    f"Created: {session['created_at']}",
                    f"Model: {session['model_name']}",
                    f"Transcript status: {session['transcript_status']}",
                    "",
                ]
            )
            chunks = await state.store.chunks(session["id"])
            by_sequence = {c["sequence"]: c for c in chunks}
            count = max(session["expected_chunk_count"] or 0, max(by_sequence, default=-1) + 1)
            language = None
            for sequence in range(count):
                chunk = by_sequence.get(sequence)
                if not chunk or chunk["status"] != "done":
                    lines.append("[part not transcribed]")
                    continue
                if chunk["no_speech"]:
                    continue
                detected = chunk["detected_language"]
                if detected and detected != language:
                    lines.append(f"\u2014 {LANGUAGES.get(detected, detected)} \u2014")
                    language = detected
                text = chunk["raw_text"] or ""
                if body.text == "polished":
                    text = (
                        chunk["polished_text"]
                        if chunk["polished_text"] is not None
                        else text + " (not cleaned)"
                    )
                lines.append(f"[{timestamp(chunk['start_ms'])}] {text}")
            lines.append("")
        await state.store.audit("transcript_exported", uid=user.uid)
    title = re.sub(r"[^A-Za-z0-9_-]+", "-", body.title or body.event_id).strip("-_")[:80] or "event"
    media = "text/markdown" if body.format == "md" else "text/plain"
    return Response(
        "\n".join(lines),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{title}-transcript.{body.format}"'},
    )
