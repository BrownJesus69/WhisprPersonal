"""Lazy model loading, resolved compute settings and bounded LRU residency."""

import asyncio
import gc
import logging
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import Executor
from typing import Any

from app.config import Settings
from app.services.cuda_windows import prepare_cuda_dlls
from app.services.state import ServerState


class ModelManager:
    def __init__(self, settings: Settings, state: ServerState, model_factory: Any = None) -> None:
        self.settings, self.state = settings, state
        self.factory = model_factory
        self.lock = threading.Lock()
        self.models: OrderedDict[str, Any] = OrderedDict()
        self.executor: Executor | None = None
        self.cuda_directories: list[str] = []

    def name(self, profile: str) -> str:
        return (
            self.settings.whisper_fallback_model
            if profile == "accurate"
            else self.settings.whisper_model
        )

    def get(self, profile: str) -> Any:
        """Caller must hold lock, including iteration of a model's lazy generators."""
        if profile in self.models:
            self.models.move_to_end(profile)
            self.state.model_name = self.name(profile)
            return self.models[profile]
        self.state.model_status = "loading"
        started = time.perf_counter()
        try:
            self.cuda_directories = prepare_cuda_dlls()
            self.state.cuda_dll_dirs_added = len(self.cuda_directories)
            os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
            device = self.settings.whisper_device
            if self.factory is None:
                import ctranslate2
                from faster_whisper import WhisperModel

                factory = WhisperModel
                if device == "auto":
                    device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
                elif device == "cuda" and ctranslate2.get_cuda_device_count() == 0:
                    raise RuntimeError("cuda_unavailable")
            else:
                factory = self.factory
                if device == "auto":
                    device = "cpu"
            compute = self.settings.whisper_compute_type
            if device == "cpu" and compute in {"float16", "bfloat16"}:
                compute = "int8"
                logging.getLogger(__name__).info(
                    "CPU compute fallback", extra={"event": "cpu_int8"}
                )
            while len(self.models) >= self.settings.whisper_max_loaded_models:
                _, model = self.models.popitem(last=False)
                del model
                gc.collect()
            self.models[profile] = factory(
                self.name(profile),
                device=device,
                device_index=0,
                compute_type=compute,
                num_workers=1,
                download_root=str(self.settings.models_dir),
                local_files_only=self.settings.whisper_local_files_only,
            )
            self.state.model_status, self.state.model_error = "ready", None
            self.state.model_name = self.name(profile)
            self.state.model_device, self.state.model_compute_type = device, compute
            self.state.model_load_s = time.perf_counter() - started
            self.state.model_loaded = [self.name(key) for key in self.models]
            return self.models[profile]
        except Exception as exc:
            code = "load_failed"
            if self.settings.whisper_local_files_only and (
                isinstance(exc, (FileNotFoundError, OSError))
                or type(exc).__name__ == "LocalEntryNotFoundError"
            ):
                code = "model_files_missing"
            elif "cuda" in str(exc).lower() and "unavailable" in str(exc).lower():
                code = "cuda_unavailable"
            self.state.model_status, self.state.model_error = "error", code
            self.state.model_loaded = [self.name(key) for key in self.models]
            raise

    async def preload(self) -> None:
        def load() -> None:
            with self.lock:
                self.get("turbo")

        try:
            await asyncio.get_running_loop().run_in_executor(self.executor, load)
        except Exception:
            logging.getLogger(__name__).warning(
                "Model unavailable",
                extra={"event": "model_load_failed", "code": self.state.model_error},
            )
