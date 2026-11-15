"""One offline IndicTrans2 direction in memory; all inference runs off the event loop."""

import asyncio
import gc
import os
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.config import Settings

FLORES = {"kn": "kan_Knda", "ta": "tam_Taml", "hi": "hin_Deva", "en": "eng_Latn"}
DIRECTIONS = ("en_indic", "indic_en", "indic_indic")


class TranslationError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def direction_for(source: str, target: str) -> str:
    if source not in FLORES or target not in FLORES:
        raise TranslationError("unsupported_pair")
    if source == target:
        raise TranslationError("same_language")
    return "en_indic" if source == "en" else "indic_en" if target == "en" else "indic_indic"


# A digit glued to an Indic suffix ("2.30ಕ್ಕೆ") is swallowed whole by IndicProcessor's numeral
# placeholder and leaks untranslated into the output; a space lets the suffix be translated.
# Verified on the real indic-en 1B model (2026-11-16): "at 2.30ಕ್ಕೆ Bangalore" -> "at 2: 30 pm".
_DIGIT_INDIC = re.compile(r"(?<=\d)(?=[ऀ-෿])")
_SPACED_TIME = re.compile(r"(?<=\d):\s+(?=\d)")


def prepare_source(text: str) -> str:
    return _DIGIT_INDIC.sub(" ", text)


def tidy_output(text: str) -> str:
    return _SPACED_TIME.sub(":", text)


def split_segment(text: str, language: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    try:
        from indicnlp.tokenize.sentence_tokenize import sentence_split

        sentences = sentence_split(text, lang=language)
        return [s for s in sentences if s.strip()] or [text]
    except Exception:
        return [text]


class IndicTrans2Engine:
    def __init__(
        self,
        settings: Settings,
        loader: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self.loader = loader or self._load
        self.clock = clock
        self.lock = threading.RLock()
        self.loaded_direction: str | None = None
        self.bundle: Any = None
        self.last_used = 0.0
        self.errors: dict[str, str] = {}

    def snapshot(self, direction: str) -> Path:
        repo, revision = self.settings.model_spec(direction)
        return (
            self.settings.hf_cache_dir
            / ("models--" + repo.replace("/", "--"))
            / "snapshots"
            / revision
        )

    def on_disk(self, direction: str) -> bool:
        path = self.snapshot(direction)
        required = (
            "config.json",
            "configuration_indictrans.py",
            "modeling_indictrans.py",
            "dict.SRC.json",
            "dict.TGT.json",
            "model.SRC",
            "model.TGT",
            "model.safetensors",
            "generation_config.json",
        )
        return all((path / name).is_file() for name in required)

    def status(self) -> dict[str, str]:
        # Do not acquire the generation lock: liveness must remain cheap during inference.
        return {
            d: "loaded"
            if self.loaded_direction == d
            else "error"
            if d in self.errors
            else "ready_on_disk"
            if self.on_disk(d)
            else "not_downloaded"
            for d in DIRECTIONS
        }

    def _load(self, direction: str, cpu: bool = False) -> Any:
        # Must be set before transformers is first imported; never reach the network at runtime.
        os.environ.setdefault("HF_MODULES_CACHE", str(self.settings.hf_modules_cache))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        from app.indic_processor import IndicProcessor

        repo, revision = self.settings.model_spec(direction)
        options = dict(
            revision=revision,
            cache_dir=str(self.settings.hf_cache_dir),
            local_files_only=True,
            trust_remote_code=True,
        )
        device = "cpu" if cpu else self.settings.device
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = (
            torch.float16
            if device == "cuda" and self.settings.dtype == "float16"
            else torch.float32
        )
        tokenizer = AutoTokenizer.from_pretrained(repo, **options)
        model = AutoModelForSeq2SeqLM.from_pretrained(repo, dtype=dtype, **options)
        model.to(device).eval()
        return model, tokenizer, IndicProcessor(inference=True), device

    def unload(self) -> None:
        self.bundle = None
        self.loaded_direction = None
        gc.collect()
        # Release cached GPU allocations only if torch was actually used.
        import sys

        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_initialized():
            torch.cuda.empty_cache()

    def unload_idle(self) -> None:
        if self.lock.acquire(blocking=False):
            try:
                if (
                    self.bundle is not None
                    and self.clock() - self.last_used >= self.settings.idle_unload_s
                ):
                    self.unload()
            finally:
                self.lock.release()

    def _generate(self, texts: list[str], source: str, target: str) -> list[str]:
        import torch

        model, tokenizer, processor, device = self.bundle
        prepared = processor.preprocess_batch(
            [prepare_source(t) for t in texts], src_lang=FLORES[source], tgt_lang=FLORES[target]
        )
        inputs = tokenizer(prepared, truncation=True, padding="longest", return_tensors="pt").to(
            device
        )
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                num_beams=self.settings.num_beams,
                max_length=self.settings.max_length,
                # IndicTrans2's remote code indexes legacy tuple caches; transformers 4.57 passes
                # Cache objects and crashes (verified). No cache: ~0.2 s/sentence on the GPU.
                use_cache=False,
            )
        decoded = tokenizer.batch_decode(output, skip_special_tokens=True)
        return [tidy_output(t) for t in processor.postprocess_batch(decoded, lang=FLORES[target])]

    def translate_sync(self, source: str, target: str, texts: list[str]) -> list[str]:
        direction = direction_for(source, target)
        with self.lock:
            if not self.on_disk(direction):
                raise TranslationError("model_not_downloaded")
            pieces = [split_segment(t, source, self.settings.max_segment_chars) for t in texts]
            flattened = [p for group in pieces for p in group]
            for attempt in range(2):
                try:
                    if self.loaded_direction != direction:
                        self.unload()
                        self.bundle = self.loader(direction, cpu=bool(attempt))
                        self.loaded_direction = direction
                    results = []
                    for offset in range(0, len(flattened), self.settings.batch_size):
                        batch = flattened[offset : offset + self.settings.batch_size]
                        translated = self._generate(batch, source, target)
                        if len(translated) != len(batch) or any(not t.strip() for t in translated):
                            raise TranslationError("translation_failed")
                        results.extend(translated)
                    joined = []
                    offset = 0
                    for group in pieces:
                        joined.append(" ".join(results[offset : offset + len(group)]))
                        offset += len(group)
                    self.errors.pop(direction, None)
                    return joined
                except TranslationError:
                    raise
                except Exception as exc:
                    oom = type(exc).__name__ in {"OutOfMemoryError", "CudaOutOfMemoryError"}
                    self.unload()
                    if oom and attempt == 0 and self.settings.cpu_retry_on_oom:
                        continue
                    code = "cuda_oom" if oom else "translation_failed"
                    self.errors[direction] = code
                    raise TranslationError(code) from None
                finally:
                    self.last_used = self.clock()
            raise TranslationError("translation_failed")

    async def translate(self, source: str, target: str, texts: list[str]) -> list[str]:
        return await asyncio.to_thread(self.translate_sync, source, target, texts)
