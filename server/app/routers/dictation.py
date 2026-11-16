"""Ephemeral voice-keyboard inference on the live worker's serialized executor."""

import asyncio
import io
import json
import logging
import wave
from typing import Annotated

import numpy as np
from fastapi import APIRouter, File, Form, Request, UploadFile
from pydantic import BaseModel

from app.core.errors import AppError, ErrorCode
from app.core.request_context import request_id_var
from app.models.languages import validate_language
from app.routers.sessions import User
from app.security.ownership import check_event_owner_offline_tolerant, require_owner
from app.services.language import LanguageTracker
from app.services.transcription import AudioClip, EngineError

router = APIRouter(prefix="/api/v1/dictation")
MAX_AUDIO_BYTES = 120 * 16000 * 2 + 4096
MAX_BODY_BYTES = 4 * 1024 * 1024


class DictationOut(BaseModel):
    text: str
    language: str | None
    duration_ms: int


def read_wav(data: bytes) -> AudioClip:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError
            frames = wav.getnframes()
            if not 0 < frames <= 120 * 16000:
                raise ValueError
            pcm = wav.readframes(frames)
            if len(pcm) != frames * 2:
                raise ValueError
        return AudioClip(np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768, frames / 16000)
    except (wave.Error, EOFError, ValueError):
        raise AppError(
            ErrorCode.validation_error,
            "Use a 16 kHz mono PCM16 WAV between 0 and 120 seconds.",
        ) from None


@router.post("", response_model=DictationOut)
async def dictate(
    request: Request,
    user: User,
    file: Annotated[UploadFile, File()],
    language: Annotated[str, Form()] = "auto",
    event_id: Annotated[str | None, Form()] = None,
) -> DictationOut:
    state = request.app.state
    mode = validate_language(language, state.settings, allow_auto=True)
    hotwords = None
    if event_id is not None:
        verified = await check_event_owner_offline_tolerant(
            event_id, user, state.event_repository, state.store
        )
        if verified:
            rows = await state.store.rows(
                "SELECT owner_uid,terms_json FROM vocabulary WHERE event_id=?", (event_id,)
            )
            if rows:
                require_owner(rows[0]["owner_uid"], user)
                hotwords = ", ".join(json.loads(rows[0]["terms_json"]))[:400]
    data = await file.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise AppError(ErrorCode.validation_error, "Recording must be at most 120 seconds.")
    clip = await asyncio.to_thread(read_wav, data)
    worker = state.worker
    if state.server_state.model_status != "ready" or worker.executor is None:
        raise AppError(ErrorCode.model_not_ready, "Speech recognition is still loading.")
    # Lock admission against chunk uploads; count ephemeral requests without persisting them.
    async with state.store.mutation_lock:
        if (
            await state.store.queue_depth() + worker.dictation_pending
            >= state.settings.queue_max_depth
        ):
            raise AppError(ErrorCode.queue_full, "Transcription queue is full.")
        worker.dictation_pending += 1
    request_id = request_id_var.get()

    def infer() -> DictationOut:
        # The audio stays in memory only; it is never written to disk.
        try:
            if state.server_state.model_status != "ready":
                raise AppError(ErrorCode.model_not_ready, "Speech recognition is still loading.")
            speech = worker.engine.speech_seconds(clip)
            tracker = LanguageTracker(state.settings, mode)
            probs = (
                worker.engine.detect(clip, "turbo")
                if speech >= 0.2 and tracker.needs_detection()
                else None
            )
            decision = tracker.decide(0, probs, speech)
            text = ""
            if speech >= 0.2:
                text = worker.engine.transcribe(
                    clip, "turbo", decision.language, hotwords, lambda segment: None
                ).raw_text_full
            result = DictationOut(
                text=text,
                language=decision.language if speech >= 0.2 else None,
                duration_ms=round(clip.duration_s * 1000),
            )
            logging.getLogger(__name__).info(
                "Dictation completed",
                extra={"request_id": request_id, "duration_ms": result.duration_ms},
            )
            return result
        except EngineError as exc:
            code = (
                ErrorCode.model_not_ready
                if exc.code
                in {"model_not_ready", "load_failed", "model_files_missing", "cuda_unavailable"}
                else ErrorCode.internal_error
            )
            raise AppError(code, "Speech recognition could not complete.") from None
        except AppError:
            raise
        except Exception:
            # Provider exceptions can contain text; never pass them to exception logging.
            raise AppError(
                ErrorCode.internal_error, "Speech recognition could not complete."
            ) from None

    future = asyncio.get_running_loop().run_in_executor(worker.executor, infer)
    # Capacity remains reserved until inference actually ends, even after disconnection.
    future.add_done_callback(
        lambda done: setattr(worker, "dictation_pending", worker.dictation_pending - 1)
    )
    return await asyncio.shield(future)
