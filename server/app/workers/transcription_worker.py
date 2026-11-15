"""One durable queue consumer and one executor serialize all inference work."""

import asyncio
import json
import logging
import random
import shutil
import sqlite3
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict
from typing import Any

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.core.request_context import chunk_id_var, session_id_var
from app.services.broadcaster import Broadcaster
from app.services.firestore_sync import FirestoreSyncError
from app.services.language import LanguageTracker
from app.services.model_manager import ModelManager
from app.services.overlap import (
    ChunkWords,
    render,
    stitch,
    to_absolute,
    words_from_json,
    words_to_json,
)
from app.services.state import ServerState
from app.services.store import Store, audit_in, event_in, update, utc_now
from app.services.transcription import EngineError, SegmentOut, TranscriptionEngine


def missing_sequences(session: dict[str, Any], chunks: list[dict[str, Any]]) -> list[int]:
    count = session["expected_chunk_count"]
    present = {chunk["sequence"] for chunk in chunks}
    return [] if count is None else [seq for seq in range(count) if seq not in present]


def _chunk_words(row: dict[str, Any]) -> ChunkWords:
    return ChunkWords(
        row["start_ms"], row["end_ms"], words_from_json(json.loads(row["words_json"]))
    )


def restitch(conn: sqlite3.Connection, session_id: str, sequence: int) -> dict[int, dict[str, Any]]:
    """Recompute stitched text for a chunk and its transcribed neighbours.

    Returns rows for `sequence` (always) and for neighbours whose text changed. Rows without
    stored words (no speech) still act as neighbours with no words.
    """
    rows = {
        row["sequence"]: dict(row)
        for row in conn.execute(
            "SELECT * FROM chunks WHERE session_id=? AND status='done' "
            "AND sequence BETWEEN ? AND ? AND words_json IS NOT NULL",
            (session_id, sequence - 2, sequence + 2),
        )
    }
    changed: dict[int, dict[str, Any]] = {}
    for target in (sequence - 1, sequence, sequence + 1):
        row = rows.get(target)
        if row is None:
            continue
        previous, following = rows.get(target - 1), rows.get(target + 1)
        kept = stitch(
            _chunk_words(row),
            _chunk_words(previous) if previous else None,
            _chunk_words(following) if following else None,
        )
        text, segments = render(kept)
        segments_json = json.dumps(segments)
        if target == sequence or (text, segments_json) != (row["raw_text"], row["segments_json"]):
            update(
                conn,
                "chunks",
                {"raw_text": text, "segments_json": segments_json},
                "session_id=? AND sequence=?",
                (session_id, target),
            )
            row.update(raw_text=text, segments_json=segments_json)
            changed[target] = row
    return changed


def revised_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "chunk_id": row["chunk_id"],
        "sequence": row["sequence"],
        "start_ms": row["start_ms"],
        "end_ms": row["end_ms"],
        "raw_text": row["raw_text"],
        "segments": json.loads(row["segments_json"]),
        "detected_language": row["detected_language"],
        "language_confidence": row["language_confidence"],
        "language_source": row["language_source"],
        "language_uncertain": bool(row["language_uncertain"]),
        "no_speech": bool(row["no_speech"]),
    }


class TranscriptionWorker:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        engine: TranscriptionEngine,
        model_manager: ModelManager,
        broadcaster: Broadcaster,
        firestore_sync: Any,
        state: ServerState,
    ) -> None:
        self.settings, self.store, self.engine = settings, store, engine
        self.manager, self.broadcaster, self.sync, self.state = (
            model_manager,
            broadcaster,
            firestore_sync,
            state,
        )
        self.wakeup = asyncio.Event()
        self.stopping = False
        self.task: asyncio.Task[None] | None = None
        self.executor: ThreadPoolExecutor | None = None
        self.preload_task: asyncio.Task[None] | None = None
        self.session_locks: dict[str, asyncio.Lock] = {}
        self.sync_task: asyncio.Task[None] | None = None
        # Resolved lazily so tests (and app.state swaps) see the current repository.
        self.event_repository_provider: Callable[[], Any] | None = None
        self.background: set[asyncio.Task[None]] = set()
        self.audio_fallback: Any = None
        self.audio_translation_jobs: Any = None

    def session_lock(self, session_id: str) -> asyncio.Lock:
        return self.session_locks.setdefault(session_id, asyncio.Lock())

    async def start(self) -> None:
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
        self.manager.executor = self.executor
        counts = await self.store.recover_on_startup()
        logging.getLogger(__name__).info(
            "Queue recovered", extra={"event": "queue_recovered", **counts}
        )
        self.state.queue_depth = await self.store.queue_depth()
        self.state.queue_status = "running"
        if self.settings.whisper_preload:
            self.preload_task = asyncio.create_task(
                self.manager.preload(), name="Model preload (~20 min first download)"
            )
        self.task = asyncio.create_task(self.run(), name="Transcription queue (~server lifetime)")
        # Firestore retries live in their own task so an offline Firestore never delays
        # transcription.
        self.sync_task = asyncio.create_task(
            self.sync_loop(), name="Firestore sync retry (~server lifetime)"
        )

    async def sync_loop(self) -> None:
        while not self.stopping:
            try:
                await asyncio.sleep(self.settings.firestore_sync_retry_s)
                await self.retry_sync()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).error(
                    "Firestore sync sweep failed", extra={"event": "firestore_sync_error"}
                )

    def schedule_sync(self, session_id: str) -> None:
        """Best-effort background sync; failures stay pending for the retry sweep."""

        async def run() -> None:
            session = await self.store.session(session_id)
            if session:
                await self.sync_session(session)

        task = asyncio.create_task(run(), name="Firestore session sync (~10 s max)")
        self.background.add(task)
        task.add_done_callback(self.background.discard)

    def notify(self) -> None:
        self.wakeup.set()

    async def emit(self, session_id: str, kind: str, data: dict[str, Any]) -> None:
        message = await self.store.transaction(lambda conn: event_in(conn, session_id, kind, data))
        self.broadcaster.publish(session_id, message)

    async def run(self) -> None:
        for session in await self.store.rows("SELECT * FROM sessions WHERE status='finalizing'"):
            await self.maybe_finalize(session["id"])
        while not self.stopping:
            self.wakeup.clear()
            try:
                chunk = None
                if self.state.model_status == "ready" or (
                    self.state.model_status == "error"
                    and self.settings.groq_audio_configured
                    and self.state.model_error
                    in {"load_failed", "model_files_missing", "cuda_unavailable", "model_not_ready"}
                ):
                    async with self.store.mutation_lock:

                        def claim(conn: sqlite3.Connection) -> dict[str, Any] | None:
                            row = conn.execute(
                                "SELECT * FROM chunks WHERE status='queued' AND next_attempt_at<=? "
                                "ORDER BY created_at,sequence LIMIT 1",
                                (time.time(),),
                            ).fetchone()
                            if row is None:
                                return None
                            result = dict(row)
                            update(
                                conn,
                                "chunks",
                                {"status": "processing", "updated_at": utc_now()},
                                "session_id=? AND chunk_id=?",
                                (result["session_id"], result["chunk_id"]),
                            )
                            message = event_in(
                                conn,
                                result["session_id"],
                                "chunk_processing",
                                {"chunk_id": result["chunk_id"], "sequence": result["sequence"]},
                            )
                            result["_message"] = message
                            return result

                        chunk = await self.store.transaction(claim)
                if chunk is not None:
                    self.broadcaster.publish(chunk["session_id"], chunk.pop("_message"))
                    await self.process(chunk)
                    self.state.queue_depth = await self.store.queue_depth()
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).error(
                    "Queue operation failed", extra={"event": "queue_error"}
                )
            try:
                await asyncio.wait_for(self.wakeup.wait(), timeout=1)
            except TimeoutError:
                pass

    @contextmanager
    def context(self, session_id: str, chunk_id: str) -> Any:
        session_token = session_id_var.set(session_id)
        chunk_token = chunk_id_var.set(chunk_id)
        try:
            yield
        finally:
            chunk_id_var.reset(chunk_token)
            session_id_var.reset(session_token)

    async def process(self, chunk: dict[str, Any]) -> None:
        sid, cid = chunk["session_id"], chunk["chunk_id"]
        loop = asyncio.get_running_loop()
        async with self.session_lock(sid):
            with self.context(sid, cid):
                session = await self.store.session(sid)
                if session is None:
                    return
                tracker = LanguageTracker.from_state(
                    json.loads(session["tracker_state"]), self.settings
                )
                vocabulary = await self.store.rows(
                    "SELECT terms_json FROM vocabulary WHERE event_id=?", (session["event_id"],)
                )
                hotwords = (
                    ", ".join(json.loads(vocabulary[0]["terms_json"]))[:400] if vocabulary else None
                )
                started = time.perf_counter()

                def infer() -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]], float]:
                    with self.context(sid, cid):
                        if self.state.model_status == "error" and self.state.model_error in {
                            "load_failed",
                            "model_files_missing",
                            "cuda_unavailable",
                            "model_not_ready",
                        }:
                            raise EngineError(self.state.model_error)
                        clip = self.engine.load_audio(
                            self.store.audio_dir / sid / chunk["file_name"]
                        )
                        if (
                            clip.duration_s
                            > self.settings.max_chunk_duration_s + chunk["overlap_ms"] / 1000
                        ):
                            raise EngineError("chunk_too_long")
                        speech = self.engine.speech_seconds(clip)
                        # Per-chunk overrides do not change the session's tracker mode.
                        active = (
                            LanguageTracker(self.settings, chunk["language_requested"])
                            if chunk["language_requested"]
                            else tracker
                        )
                        probs = (
                            self.engine.detect(clip, session["model_profile"])
                            if speech >= 0.2 and active.needs_detection()
                            else None
                        )
                        decision = active.decide(chunk["sequence"], probs, speech)
                        values: dict[str, Any] = {
                            "detected_language": decision.language,
                            "language_confidence": decision.confidence,
                            "language_source": decision.source,
                            "language_uncertain": int(decision.uncertain),
                            "no_speech": int(speech < 0.2),
                            "raw_text": "",
                            "raw_text_full": "",
                            "segments_json": "[]",
                            "words_json": "[]",
                        }
                        if speech >= 0.2:

                            def partial(segment: SegmentOut) -> None:
                                if self.stopping:
                                    return
                                self.broadcaster.publish_threadsafe(
                                    loop,
                                    sid,
                                    {
                                        "type": "transcript_partial",
                                        "session_id": sid,
                                        "chunk_id": cid,
                                        "sequence": chunk["sequence"],
                                        "data": asdict(segment),
                                    },
                                )

                            output = self.engine.transcribe(
                                clip, session["model_profile"], decision.language, hotwords, partial
                            )
                            # Untrimmed timed words; seams are stitched in finish() using
                            # whichever neighbouring chunks are already transcribed.
                            absolute = to_absolute(output.words, chunk["start_ms"])
                            raw_text, segments = render(absolute)
                            values.update(
                                raw_text=raw_text,
                                raw_text_full=output.raw_text_full,
                                segments_json=json.dumps(segments),
                                words_json=json.dumps(words_to_json(absolute)),
                            )
                        return values, decision.events, clip.duration_s

                try:
                    values, events, duration_s = await loop.run_in_executor(self.executor, infer)
                    elapsed = int((time.perf_counter() - started) * 1000)
                    values.update(
                        status="done", error_code=None, processing_ms=elapsed, updated_at=utc_now()
                    )

                    def finish(conn: sqlite3.Connection) -> list[dict[str, Any]]:
                        update(conn, "chunks", values, "session_id=? AND chunk_id=?", (sid, cid))
                        stitched = restitch(conn, sid, chunk["sequence"])
                        own = stitched[chunk["sequence"]]
                        values.update(raw_text=own["raw_text"], segments_json=own["segments_json"])
                        update(
                            conn,
                            "sessions",
                            {
                                "tracker_state": json.dumps(tracker.to_state()),
                                "updated_at": utc_now(),
                            },
                            "id=?",
                            (sid,),
                        )
                        data = {
                            key: values[key]
                            for key in (
                                "raw_text",
                                "detected_language",
                                "language_confidence",
                                "language_source",
                                "language_uncertain",
                                "no_speech",
                            )
                        }
                        data.update(
                            chunk_id=cid,
                            sequence=chunk["sequence"],
                            start_ms=chunk["start_ms"],
                            end_ms=chunk["end_ms"],
                            segments=json.loads(values["segments_json"]),
                        )
                        data["no_speech"], data["language_uncertain"] = (
                            bool(data["no_speech"]),
                            bool(data["language_uncertain"]),
                        )
                        messages = [event_in(conn, sid, "transcript_final", data)]
                        # Neighbours whose stitched text changed now that this chunk exists.
                        messages.extend(
                            event_in(conn, sid, "transcript_revised", revised_payload(row))
                            for seq, row in sorted(stitched.items())
                            if seq != chunk["sequence"]
                        )
                        messages.extend(
                            event_in(conn, sid, kind, payload) for kind, payload in events
                        )
                        audit_in(
                            conn,
                            "chunk_transcribed",
                            sid,
                            cid,
                            duration_ms=elapsed,
                            model=session["model_name"],
                            detail={"real_time_factor": elapsed / max(1, duration_s * 1000)},
                        )
                        return messages

                    for message in await self.store.transaction(finish):
                        self.broadcaster.publish(sid, message)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    code = exc.code if isinstance(exc, EngineError) else "transcription_failed"
                    attempts = chunk["attempts"] + 1
                    terminal = attempts >= self.settings.chunk_max_attempts
                    delay = (
                        self.settings.chunk_retry_base_s
                        * 2 ** (attempts - 1)
                        * random.uniform(0.8, 1.2)  # noqa: S311 -- retry jitter
                    )

                    def fail(conn: sqlite3.Connection) -> dict[str, Any] | None:
                        audit_in(
                            conn,
                            "chunk_failed",
                            sid,
                            cid,
                            outcome=code,
                            model=session["model_name"],
                        )
                        update(
                            conn,
                            "chunks",
                            {
                                "status": "failed" if terminal else "queued",
                                "attempts": attempts,
                                "next_attempt_at": time.time() + delay,
                                "error_code": code,
                                "updated_at": utc_now(),
                            },
                            "session_id=? AND chunk_id=?",
                            (sid, cid),
                        )
                        return (
                            event_in(
                                conn,
                                sid,
                                "chunk_failed",
                                {
                                    "chunk_id": cid,
                                    "sequence": chunk["sequence"],
                                    "error_code": code,
                                },
                            )
                            if terminal
                            else None
                        )

                    message = await self.store.transaction(fail)
                    if message:
                        self.broadcaster.publish(sid, message)
                        if self.audio_fallback and self.audio_translation_jobs:
                            try:
                                await self.audio_fallback.enqueue(
                                    self.audio_translation_jobs, session, chunk, code
                                )
                            except Exception:
                                logging.getLogger(__name__).warning(
                                    "Audio fallback unavailable",
                                    extra={"event": "audio_fallback_unavailable"},
                                )
        await self.maybe_finalize(sid)

    async def maybe_finalize(self, session_id: str) -> None:
        async with self.store.mutation_lock:

            def finalize(conn: sqlite3.Connection) -> dict[str, Any] | None:
                row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
                if row is None or row["status"] != "finalizing":
                    return None
                session = dict(row)
                chunks = [
                    dict(c)
                    for c in conn.execute("SELECT * FROM chunks WHERE session_id=?", (session_id,))
                ]
                missing = missing_sequences(session, chunks)
                if any(c["status"] in {"queued", "processing"} for c in chunks) or (
                    missing and not session["force_finalize"]
                ):
                    return None
                failed = sorted(c["sequence"] for c in chunks if c["status"] == "failed")
                transcript_status = "partial" if missing or failed else "complete"
                update(
                    conn,
                    "sessions",
                    {
                        "status": "finalized",
                        "transcript_status": transcript_status,
                        "finalized_at": utc_now(),
                        "updated_at": utc_now(),
                        "firestore_sync": "pending" if self.sync.enabled else "disabled",
                    },
                    "id=?",
                    (session_id,),
                )
                return event_in(
                    conn,
                    session_id,
                    "session_finalized",
                    {
                        "transcript_status": transcript_status,
                        "missing_sequences": missing,
                        "failed_sequences": failed,
                    },
                )

            message = await self.store.transaction(finalize)
            if message is None:
                return
            self.broadcaster.publish(session_id, message)
            await self.store.audit("session_finalized", session_id)
            if self.settings.server_audio_retention == "delete_on_finalize":
                await asyncio.to_thread(shutil.rmtree, self.store.audio_dir / session_id, True)
        session = await self.store.session(session_id)
        if session:
            await self.sync_session(session)

    async def sync_session(self, session: dict[str, Any]) -> None:
        if not self.sync.enabled:
            return
        # Deletion and sync share the session lock so a retry cannot recreate a deleted doc.
        async with self.session_lock(session["id"]):
            session = await self.store.session(session["id"])
            if session is None:
                return
            if session["ownership_pending"] and not await self.verify_pending_ownership(session):
                return
            try:
                if session["status"] == "finalized":
                    await self.sync.session_finalized(
                        session, await self.store.chunks(session["id"])
                    )
                else:
                    await self.sync.session_started(session)
                status, error = "synced", None
            except FirestoreSyncError:
                status, error = "failed", "firestore_unavailable"
            await self.store.execute(
                "UPDATE sessions SET firestore_sync=?,firestore_error=? "
                "WHERE id=? AND status=? AND updated_at=?",
                (status, error, session["id"], session["status"], session["updated_at"]),
            )
            await self.store.audit("firestore_sync", session["id"], outcome=status)

    async def verify_pending_ownership(self, session: dict[str, Any]) -> bool:
        """Session created offline for an event never verified here: check before any write.

        Returns True when ownership is now verified (the caller syncs). Otherwise records why:
        Firestore still unreachable or the event not uploaded by the phone yet -> retry later;
        the event belongs to someone else -> quarantined, never written to Firestore.
        """
        sid = session["id"]
        repo = self.event_repository_provider() if self.event_repository_provider else None
        outcome, error = "failed", "firestore_unavailable"
        try:
            if repo is None:
                raise AppError(ErrorCode.firestore_unavailable, "No repository.")
            owner = await repo.get_event_owner(session["event_id"])
        except AppError as exc:
            if exc.code != ErrorCode.firestore_unavailable:
                raise
        else:
            if owner == session["owner_uid"]:
                await self.store.execute(
                    "INSERT INTO event_owners (event_id, owner_uid, verified_at) VALUES (?,?,?) "
                    "ON CONFLICT(event_id) DO UPDATE SET owner_uid=excluded.owner_uid, "
                    "verified_at=excluded.verified_at",
                    (session["event_id"], owner, utc_now()),
                )
                await self.store.execute(
                    "UPDATE sessions SET ownership_pending=0 WHERE id=?", (sid,)
                )
                await self.store.audit("ownership_verified", sid, uid=owner)
                return True
            if owner is None:
                error = "event_not_found_yet"
            else:
                outcome, error = "disabled", "ownership_mismatch"
                await self.store.audit("ownership_rejected", sid, outcome=error)
        await self.store.execute(
            "UPDATE sessions SET firestore_sync=?, firestore_error=? WHERE id=?",
            (outcome, error, sid),
        )
        return False

    async def retry_sync(self) -> None:
        for session in await self.store.rows(
            "SELECT * FROM sessions WHERE firestore_sync IN ('pending','failed')"
        ):
            await self.sync_session(session)

    async def stop(self) -> None:
        self.stopping = True
        self.state.queue_status = "stopping"
        self.notify()
        for task in (self.sync_task, *self.background):
            if task is not None:
                task.cancel()
        tasks = [task for task in (self.task, self.preload_task) if task is not None]
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=self.settings.shutdown_drain_timeout_s)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        if self.executor:
            self.executor.shutdown(wait=False, cancel_futures=True)
