"""Authenticated IndicTrans2 first; explicitly enabled, benchmarked local Argos second."""

import asyncio
import json
import math
import time
from typing import Any

import httpx

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.services.store import utc_now

LANGUAGES = {"kn", "ta", "hi", "en"}
DIRECTIONS = ("en_indic", "indic_en", "indic_indic")
UNAVAILABLE = "Translation unavailable; showing the original transcript."


def direction_for(source: str, target: str) -> str:
    return "en_indic" if source == "en" else "indic_en" if target == "en" else "indic_indic"


def unavailable() -> AppError:
    return AppError(ErrorCode.translation_unavailable, UNAVAILABLE)


class TranslatorClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings, self.client = settings, client

    async def status(self) -> dict[str, str]:
        if not self.settings.translator_shared_secret:
            return dict.fromkeys(DIRECTIONS, "not_configured")
        try:
            async with asyncio.timeout(2):
                response = await self.client.get(
                    self.settings.translator_url + "/health", timeout=2
                )
            response.raise_for_status()
            data = response.json()
            if data.get("configured") is not True:
                return dict.fromkeys(DIRECTIONS, "not_configured")
            words = {"not_downloaded", "ready_on_disk", "loaded", "error"}
            return {
                d: data["directions"][d] if data["directions"].get(d) in words else "error"
                for d in DIRECTIONS
            }
        except Exception:
            return dict.fromkeys(DIRECTIONS, "unavailable")

    async def translate(self, source: str, target: str, segments: list[dict[str, str]]) -> Any:
        secret = self.settings.translator_shared_secret
        if not secret:
            raise unavailable()
        try:
            response = await self.client.post(
                self.settings.translator_url + "/translate",
                headers={"X-WhisprPersonal-Translator-Key": secret.get_secret_value()},
                json={"source_lang": source, "target_lang": target, "segments": segments},
                timeout=self.settings.translator_timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            expected = [s["id"] for s in segments]
            if (
                data["engine"] != "indictrans2"
                or not isinstance(data["model"], str)
                or data["source_lang"] != source
                or data["target_lang"] != target
                or [s["id"] for s in data["segments"]] != expected
                or any(
                    not isinstance(s["text"], str) or not s["text"].strip()
                    for s in data["segments"]
                )
                or not isinstance(data["created_at"], str)
            ):
                raise ValueError
            return data
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise unavailable() from None


class LibreTranslateClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings, self.client = settings, client

    async def status(self) -> set[str]:
        try:
            async with asyncio.timeout(2):
                response = await self.client.get(
                    self.settings.libretranslate_url + "/languages", timeout=2
                )
            response.raise_for_status()
            return {
                f"{language['code']}-{target}"
                for language in response.json()
                if language["code"] in LANGUAGES
                for target in language["targets"]
                if target in LANGUAGES and target != language["code"]
            }
        except Exception:
            return set()

    async def translate(self, source: str, target: str, segments: list[dict[str, str]]) -> Any:
        results = []
        try:
            for segment in segments:
                response = await self.client.post(
                    self.settings.libretranslate_url + "/translate",
                    json={
                        "q": segment["text"],
                        "source": source,
                        "target": target,
                        "format": "text",
                    },
                    timeout=self.settings.translator_timeout_s,
                )
                response.raise_for_status()
                text = response.json()["translatedText"]
                if not isinstance(text, str) or not text.strip():
                    raise ValueError
                results.append({"id": segment["id"], "text": text})
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise unavailable() from None
        return {
            "engine": "libretranslate",
            "model": "argos",
            "source_lang": source,
            "target_lang": target,
            "segments": results,
            "created_at": utc_now(),
        }


class TranslationRouter:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings = settings
        self.indic = TranslatorClient(settings, client)
        self.libre = LibreTranslateClient(settings, client)
        self.cached = dict.fromkeys(DIRECTIONS, "not_checked")
        self.checked_at = -math.inf
        self.probe_lock = asyncio.Lock()
        self.benchmark_mtime: tuple[int, int] | None = None
        self.eligible: set[str] = set()
        self.libre_available: set[str] = set()

    def read_benchmark(self) -> None:
        try:
            path = self.settings.translation_benchmark_path
            stat = path.stat()
            mtime = (stat.st_mtime_ns, stat.st_size)
            if mtime == self.benchmark_mtime:
                return
            eligible: set[str] = set()
            data = json.loads(path.read_text(encoding="utf-8"))
            engines = data["engines"]
            for pair, metrics in engines.get("libretranslate", {}).items():
                score = metrics["chrf"]
                baseline = engines.get("indictrans2", {}).get(pair, {}).get("chrf")
                if (
                    metrics.get("eligible") is True
                    and type(score) in (float, int)
                    and math.isfinite(score)
                    and score >= 35
                    and type(metrics.get("n")) is int
                    and metrics["n"] >= 12
                    and (
                        baseline is None
                        or (
                            type(baseline) in (float, int)
                            and math.isfinite(baseline)
                            and score >= 0.9 * baseline
                        )
                    )
                ):
                    eligible.add(pair)
            self.eligible = eligible
            self.benchmark_mtime = mtime
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            self.eligible = set()
            self.benchmark_mtime = None

    def status(self) -> dict[str, Any]:
        return {
            "indictrans2": dict(self.cached),
            "libretranslate": {
                pair: {
                    "enabled": pair in self.settings.libretranslate_enabled_pairs,
                    "eligible": pair in self.eligible,
                    "available": pair in self.libre_available,
                }
                for pair in sorted(set(self.settings.libretranslate_enabled_pairs) | self.eligible)
            },
            "groq_audio": {"configured": self.settings.groq_audio_configured},
        }

    async def refresh(self) -> dict[str, Any]:
        async with self.probe_lock:
            await asyncio.to_thread(self.read_benchmark)
            if time.monotonic() - self.checked_at >= 30:

                async def libre_status() -> set[str]:
                    if self.eligible.intersection(self.settings.libretranslate_enabled_pairs):
                        return await self.libre.status()
                    return set()

                self.cached, self.libre_available = await asyncio.gather(
                    self.indic.status(), libre_status()
                )
                self.checked_at = time.monotonic()
        return self.status()

    async def can_serve(self, source: str, target: str) -> bool:
        if source not in LANGUAGES or target not in LANGUAGES or source == target:
            return False
        await self.refresh()
        pair = f"{source}-{target}"
        return self.cached[direction_for(source, target)] in {"loaded", "ready_on_disk"} or (
            pair in self.settings.libretranslate_enabled_pairs
            and pair in self.eligible
            and pair in self.libre_available
        )

    async def translate(self, source: str, target: str, segments: list[dict[str, str]]) -> Any:
        if not await self.can_serve(source, target):
            raise unavailable()
        if self.cached[direction_for(source, target)] in {"loaded", "ready_on_disk"}:
            try:
                return await self.indic.translate(source, target, segments)
            except AppError:
                pass
        pair = f"{source}-{target}"
        if (
            pair in self.settings.libretranslate_enabled_pairs
            and pair in self.eligible
            and pair in self.libre_available
        ):
            return await self.libre.translate(source, target, segments)
        raise unavailable()
