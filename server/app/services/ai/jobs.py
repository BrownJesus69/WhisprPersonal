"""Bounded durable jobs; the single worker is independent of transcription/GPU work."""

import asyncio
import json
import logging
import sqlite3
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.security.ownership import EventOwnershipRepository
from app.services.ai.validate import validate_brief, validate_cleanup
from app.services.llm.base import ChatRequest, ChatResult
from app.services.llm.prompts import brief_messages, cleanup_messages
from app.services.llm.router import NoProviderAvailable, ProviderRouter
from app.services.llm.usage import UsageContext, usage_context
from app.services.store import Store, insert, update, utc_now


def partition(lines: list[str], budget: int) -> list[str]:
    """Never split speech chunks or silently truncate owner notes."""
    parts: list[str] = []
    current = ""
    for line in lines:
        if len(line) > budget:
            raise AppError(ErrorCode.transcript_too_long, "Transcript exceeds AI input budget.")
        if len(current) + len(line) + bool(current) > budget:
            parts.append(current)
            current = ""
        current += ("\n" if current else "") + line
    if current:
        parts.append(current)
    return parts


async def event_cloud_access(repo: EventOwnershipRepository, event_id: str, uid: str) -> bool:
    try:
        access = await repo.get_event_access(event_id)
    except Exception:
        raise AppError(
            ErrorCode.privacy_mode_unknown, "Event privacy mode could not be verified."
        ) from None
    if access is None:
        raise AppError(ErrorCode.privacy_mode_unknown, "Event privacy mode could not be verified.")
    if access.owner_uid != uid:
        raise AppError(ErrorCode.not_found, "Event not found.")
    if access.privacy_mode not in {"cloud_ai", "local_only"}:
        raise AppError(ErrorCode.privacy_mode_unknown, "Event privacy mode could not be verified.")
    return access.privacy_mode == "cloud_ai"


class AIJobService:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        router: ProviderRouter,
        repository: Callable[[], EventOwnershipRepository],
        sync: Callable[[], Any],
    ) -> None:
        self.settings = settings
        self.store = store
        self.router = router
        self.repository = repository
        self.sync = sync
        self.queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue(settings.ai_queue_max)
        self.accepting = False
        self.task: asyncio.Task[None] | None = None
        self.sync_tasks: set[asyncio.Task[None]] = set()
        self.admission_lock = asyncio.Lock()

    async def start(self) -> None:
        from app.workers.ai_worker import run_worker

        self.accepting = True
        self.task = asyncio.create_task(run_worker(self), name="AI job worker (~10 min/job)")

    async def stop(self) -> None:
        async with self.admission_lock:
            self.accepting = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        await self.store.execute(
            "UPDATE ai_jobs SET status='interrupted', updated_at=? "
            "WHERE status IN ('queued','running')",
            (utc_now(),),
        )
        for task in self.sync_tasks:
            task.cancel()
        await asyncio.gather(*self.sync_tasks, return_exceptions=True)

    async def sessions(self, ids: list[str], uid: str, event_id: str) -> list[dict[str, Any]]:
        sessions = []
        for sid in ids:
            session = await self.store.session(sid)
            if not session or session["owner_uid"] != uid or session["event_id"] != event_id:
                raise AppError(ErrorCode.not_found, "Session not found.")
            sessions.append(session)
        return sorted(sessions, key=lambda s: (s["created_at"] or "", s["id"]))

    async def submit(
        self, kind: str, uid: str, params: dict[str, Any], request_id: str
    ) -> dict[str, str]:
        async with self.admission_lock:
            if not self.accepting or self.queue.full():
                raise AppError(ErrorCode.queue_full, "AI queue is full.")
            job_id = uuid4().hex
            now = utc_now()
            await self.store.transaction(
                lambda conn: insert(
                    conn,
                    "ai_jobs",
                    {
                        "id": job_id,
                        "owner_uid": uid,
                        "kind": kind,
                        "event_id": params["event_id"],
                        "session_ids": json.dumps(params["session_ids"]),
                        "params_json": json.dumps(params),
                        "status": "queued",
                        "created_at": now,
                        "updated_at": now,
                    },
                )
            )
            self.queue.put_nowait((job_id, request_id))
            return {"job_id": job_id, "status": "queued"}

    async def set_job(self, job_id: str, **values: Any) -> None:
        values["updated_at"] = utc_now()
        await self.store.transaction(
            lambda conn: update(conn, "ai_jobs", values, "id=?", (job_id,))
        )

    async def run(self, job: dict[str, Any]) -> dict[str, Any]:
        params = json.loads(job["params_json"])
        sessions = await self.sessions(params["session_ids"], job["owner_uid"], job["event_id"])
        # Reconfirm privacy immediately before executing a queued job, never cache consent.
        allow_cloud = await event_cloud_access(self.repository(), job["event_id"], job["owner_uid"])
        if job["kind"] == "cleanup":
            return await self.cleanup(job, params, sessions, allow_cloud)
        return await self.brief(params, sessions, allow_cloud)

    async def cleanup(
        self,
        job: dict[str, Any],
        params: dict[str, Any],
        sessions: list[dict[str, Any]],
        allow_cloud: bool,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "accepted": 0,
            "rejected": 0,
            "skipped": 0,
            "provider": None,
            "model": None,
        }
        for session in sessions:
            if session["status"] != "finalized":
                raise AppError(ErrorCode.transcript_incomplete, "Session is not finalized.")
            chunks = await self.store.chunks(session["id"])
            eligible = [
                c
                for c in chunks
                if c["status"] == "done"
                and not c["no_speech"]
                and c["raw_text"]
                and c["raw_text"].strip()
            ]
            result["skipped"] += len(chunks) - len(eligible)
            # Earlier polish is replaced window by window, only once a new result exists: a
            # failed request never wipes a previous successful cleanup.
            lines = [f"<<{c['sequence']}>> {c['raw_text']}" for c in eligible]
            offset = 0
            budget = min(self.settings.ai_max_input_chars, self.settings.ai_cleanup_window_chars)
            for window in partition(lines, budget):
                # Use the actual chunk boundaries, including transcript text containing markers.
                length = 0
                window_count = 0
                for line in lines[offset:]:
                    if length + len(line) + bool(window_count) > len(window):
                        break
                    length += len(line) + bool(window_count)
                    window_count += 1
                source = eligible[offset : offset + window_count]
                offset += window_count
                response = await self.router.complete(
                    ChatRequest(
                        cleanup_messages(window, params["level"]),
                        "cleanup",
                        self.settings.ai_max_output_tokens,
                    ),
                    allow_cloud,
                )
                validated = await asyncio.to_thread(
                    validate_cleanup, response.text, source, params["level"]
                )

                def persist(
                    conn: sqlite3.Connection,
                    source: list[dict[str, Any]] = source,
                    validated: dict[int, tuple[str | None, str | None]] = validated,
                    session_id: str = session["id"],
                ) -> None:
                    for chunk in source:
                        text, error = validated[chunk["sequence"]]
                        update(
                            conn,
                            "chunks",
                            {
                                "polished_text": text,
                                "polished_level": params["level"] if text else None,
                                "polish_error": error,
                                "polished_at": utc_now() if text else None,
                            },
                            "session_id=? AND chunk_id=?",
                            (session_id, chunk["chunk_id"]),
                        )

                await self.store.transaction(persist)
                accepted = sum(text is not None for text, _ in validated.values())
                result["accepted"] += accepted
                result["rejected"] += len(source) - accepted
                result.update(provider=response.provider, model=response.model)
                await self.set_job(
                    job["id"],
                    provider=response.provider,
                    model=response.model,
                    result_json=json.dumps(result),
                )
            # Chunks no longer eligible (e.g. now silent) must not keep an old polish.
            eligible_ids = {c["chunk_id"] for c in eligible}
            stale = [
                (session["id"], c["chunk_id"]) for c in chunks if c["chunk_id"] not in eligible_ids
            ]
            if stale:
                await self.store.transaction(
                    lambda conn, rows=stale: conn.executemany(
                        "UPDATE chunks SET polished_text=NULL, polished_level=NULL, "
                        "polish_error=NULL, polished_at=NULL WHERE session_id=? AND chunk_id=?",
                        rows,
                    )
                )
            projected = await self.store.chunks(session["id"])
            task = asyncio.create_task(
                self._sync(job["event_id"], session["id"], projected),
                name="AI polished Firestore sync (~10 s)",
            )
            self.sync_tasks.add(task)
            task.add_done_callback(self.sync_tasks.discard)
        if result["rejected"] and not result["accepted"]:
            raise AppError(
                ErrorCode.ai_output_invalid, "AI cleanup output did not pass validation."
            )
        return result

    async def _sync(self, event_id: str, session_id: str, chunks: list[dict[str, Any]]) -> None:
        try:
            await asyncio.wait_for(
                self.sync().chunks_polished(event_id, session_id, chunks), timeout=10
            )
        except Exception:
            logging.getLogger(__name__).warning(
                "Polished sync failed",
                extra={
                    "event": "ai_sync_failed",
                    "session_id": session_id,
                    "error_kind": "firestore_unavailable",
                },
            )

    async def brief(
        self, params: dict[str, Any], sessions: list[dict[str, Any]], allow_cloud: bool
    ) -> dict[str, Any]:
        incomplete = any(
            s["status"] != "finalized" or s["transcript_status"] != "complete" for s in sessions
        )
        if incomplete and not params["allow_incomplete"]:
            raise AppError(ErrorCode.transcript_incomplete, "Transcript is incomplete.")
        lines = []
        count = 0
        used_polished = False
        for session in sessions:
            for chunk in await self.store.chunks(session["id"]):
                if chunk["status"] != "done" or chunk["no_speech"] or not chunk["raw_text"]:
                    continue
                polished = params["use_polished"] and chunk["polished_text"]
                used_polished = used_polished or bool(polished)
                seconds = (chunk["start_ms"] or 0) // 1000
                lines.append(
                    f"[{seconds // 60:02d}:{seconds % 60:02d}] {polished or chunk['raw_text']}"
                )
                count += 1
        for note in params["notes"]:
            # JSON preserves the boundary between owner's notes and speech.
            lines.append("Owner's note (not speech): " + json.dumps(note, ensure_ascii=False))
        budget = self.settings.ai_max_input_chars
        parts = partition(lines, budget) or ["No speech in the transcript."]

        async def generate(text: str, reduce: bool = False) -> ChatResult:
            if len(text) > budget:
                raise AppError(ErrorCode.transcript_too_long, "Transcript exceeds AI input budget.")
            return await self.router.complete(
                ChatRequest(
                    brief_messages(text, params["brief_type"], reduce),
                    "brief",
                    self.settings.ai_max_output_tokens,
                ),
                allow_cloud,
            )

        if len(parts) == 1:
            response = await generate(parts[0])
        else:
            notes = [(await generate(part)).text for part in parts]
            # At most one additional reduction level before the final combine.
            for depth in range(2):
                groups = partition(notes, budget)
                if len(groups) == 1:
                    response = await generate(groups[0], True)
                    break
                if depth == 1:
                    raise AppError(
                        ErrorCode.transcript_too_long, "Brief notes exceed AI input budget."
                    )
                notes = [(await generate(group, True)).text for group in groups]
            else:
                raise AppError(ErrorCode.transcript_too_long, "Brief notes exceed AI input budget.")
        text, structured, warning = validate_brief(response.text, params["brief_type"])
        return {
            "brief_type": params["brief_type"],
            "generated_text": text,
            "structured_brief": structured,
            "brief_warning": warning,
            "provider": response.provider,
            "model": response.model,
            "incomplete": incomplete,
            "source": {
                "session_ids": [s["id"] for s in sessions],
                "chunk_count": count,
                "used_polished": used_polished,
            },
        }

    async def process(self, job_id: str, request_id: str) -> None:
        rows = await self.store.rows("SELECT * FROM ai_jobs WHERE id=?", (job_id,))
        if not rows:
            return
        job = rows[0]
        context_token = usage_context.set(UsageContext(job_id, job["owner_uid"], request_id))
        try:
            await self.set_job(job_id, status="running")
            async with asyncio.timeout(self.settings.ai_job_timeout_s):
                result = await self.run(job)
            await self.set_job(
                job_id,
                status="done",
                result_json=json.dumps(result),
                provider=result["provider"],
                model=result["model"],
            )
        except asyncio.CancelledError:
            await self.set_job(job_id, status="interrupted")
            raise
        except TimeoutError:
            await self.set_job(job_id, status="failed", error_code="job_timeout")
        except NoProviderAvailable:
            await self.set_job(job_id, status="failed", error_code="provider_unavailable")
        except AppError as exc:
            await self.set_job(job_id, status="failed", error_code=exc.code.value)
        except Exception:
            # Do not log exception messages: SDK errors may contain content or credentials.
            logging.getLogger(__name__).error(
                "AI job failed", extra={"event": "ai_job_failed", "job_id": job_id}
            )
            await self.set_job(job_id, status="failed", error_code="ai_output_invalid")
        finally:
            usage_context.reset(context_token)
