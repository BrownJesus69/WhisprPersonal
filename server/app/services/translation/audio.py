"""Emergency audio-to-English only; never a text translator or raw transcript."""

import asyncio
import io
import wave
from pathlib import Path
from typing import Any

from app.core.errors import AppError
from app.services.ai.jobs import event_cloud_access
from app.services.llm.base import ProviderError
from app.services.llm.openai_compat import OpenAICompatibleProvider
from app.services.llm.resilience import CircuitBreaker, retry_call
from app.services.store import event_in

LOCAL_UNAVAILABLE = {"load_failed", "model_files_missing", "cuda_unavailable", "model_not_ready"}
MAX_AUDIO_BYTES = 25_000_000


class FileTooLargeError(ValueError):
    """Size guards only; decoder errors must never be mislabelled as size failures."""


def wav_bytes(path: Path) -> bytes:
    if path.stat().st_size > MAX_AUDIO_BYTES:
        raise FileTooLargeError("file_too_large")
    data = path.read_bytes()
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return data
    from faster_whisper import decode_audio

    samples = decode_audio(str(path), sampling_rate=16000)
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes((samples.clip(-1, 1) * 32767).astype("<i2").tobytes())
    data = output.getvalue()
    if len(data) > MAX_AUDIO_BYTES:
        raise FileTooLargeError("file_too_large")
    return data


class AudioFallback:
    def __init__(self, settings: Any, client: Any, provider_router: Any) -> None:
        self.settings = settings
        self.provider = OpenAICompatibleProvider(
            client,
            settings.groq_base_url,
            settings.groq_audio_translation_model,
            settings.groq_api_key,
            settings.groq_timeout_s,
        )
        self.provider.name = "groq"
        # Shared Groq capacity/RPM/breaker, including calls made by optional AI jobs.
        self.breaker: CircuitBreaker = provider_router.breakers["groq"]
        self.limiter = provider_router.limiters["groq"]
        self.semaphore = provider_router.semaphores["groq"]
        self.buffers: dict[str, bytes] = {}
        self.retry_options: dict[str, Any] = {}
        self.admission_lock = asyncio.Lock()

    async def enqueue(
        self, service: Any, session: dict[str, Any], chunk: dict[str, Any], code: str
    ) -> None:
        if code not in LOCAL_UNAVAILABLE or not self.settings.groq_audio_configured:
            return
        async with self.admission_lock:
            if not service.accepting or service.queue.full():
                return
            try:
                if not await event_cloud_access(
                    service.repository(), session["event_id"], session["owner_uid"]
                ):
                    return
                # Snapshot before finalize retention can delete audio; keep only in bounded memory.
                data = await asyncio.to_thread(
                    wav_bytes, service.store.audio_dir / session["id"] / chunk["file_name"]
                )
            except AppError:
                return
            except FileTooLargeError:
                await service.save(
                    session["id"], chunk["sequence"], "en", "und", error_code="file_too_large"
                )
                return
            except Exception:
                return
            # No await between queue submission and buffer assignment from the consumer's view:
            # hold the service admission lock inside submit until put_nowait.
            result = await service.submit(
                "audio",
                session["owner_uid"],
                {
                    "event_id": session["event_id"],
                    "session_ids": [session["id"]],
                    "sequence": chunk["sequence"],
                    "target_lang": "en",
                },
                "audio-fallback",
            )
            self.buffers[result["job_id"]] = data

    async def run(
        self, service: Any, job: dict[str, Any], session: dict[str, Any], params: dict[str, Any]
    ) -> dict[str, int]:
        data = self.buffers.pop(job["id"], None)
        if not self.settings.groq_audio_configured or data is None:
            return {"translated": 0, "failed": 1}
        sequence = params["sequence"]
        try:
            async with self.semaphore:
                if not self.breaker.allow():
                    raise ProviderError("server_error")

                async def attempt() -> str:
                    if not await event_cloud_access(
                        service.repository(), session["event_id"], session["owner_uid"]
                    ):
                        raise ProviderError("bad_request")
                    if self.limiter:
                        decision = self.limiter.check("provider")
                        if not decision.allowed:
                            raise ProviderError(
                                "rate_limited", retry_after_s=decision.retry_after_s
                            )
                    response = await self.provider._request(
                        "POST",
                        "/audio/translations",
                        files={"file": ("chunk.wav", data, "audio/wav")},
                        data={
                            "model": self.settings.groq_audio_translation_model,
                            "response_format": "json",
                            "temperature": "0",
                        },
                    )
                    try:
                        text = response.json()["text"]
                        if not isinstance(text, str) or not text.strip():
                            raise ValueError
                        return text
                    except (KeyError, TypeError, ValueError):
                        raise ProviderError("bad_response") from None

                try:
                    text = await retry_call(
                        attempt,
                        self.settings.ai_retry_max_attempts,
                        self.settings.ai_retry_max_wait_s,
                        **self.retry_options,
                    )
                except ProviderError as exc:
                    self.breaker.failure(exc.kind)
                    raise
                except asyncio.CancelledError:
                    self.breaker.probing = False
                    raise
                except AppError:
                    # Revoked/unknown consent is not a provider failure or a held probe.
                    self.breaker.probing = False
                    raise
                else:
                    self.breaker.success()
            await service.save(
                session["id"],
                sequence,
                "en",
                "und",
                text=text,
                engine="groq-audio-translation",
                model=self.settings.groq_audio_translation_model,
            )

            def persist(conn: Any) -> Any:
                if not conn.execute(
                    "SELECT 1 FROM sessions WHERE id=?", (session["id"],)
                ).fetchone():
                    return None
                return event_in(
                    conn,
                    session["id"],
                    "chunk_audio_translated",
                    {"sequence": sequence, "target_lang": "en", "engine": "groq-audio-translation"},
                )

            message = await service.store.transaction(persist)
            if message:
                service.broadcaster.publish(session["id"], message)
            return {"translated": 1, "failed": 0}
        except (ProviderError, AppError):
            await service.save(
                session["id"], sequence, "en", "und", error_code="translation_unavailable"
            )
            return {"translated": 0, "failed": 1}
