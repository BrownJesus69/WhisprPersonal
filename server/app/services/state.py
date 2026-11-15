"""Mutable inference and queue status owned by app.state."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from app.schemas.health import GpuInfo


@dataclass
class ServerState:
    started_at: datetime
    gpu: GpuInfo
    model_status: Literal["not_loaded", "loading", "ready", "error"] = "not_loaded"
    model_name: str | None = None
    model_device: Literal["cuda", "cpu"] | None = None
    model_compute_type: str | None = None
    model_load_s: float | None = None
    model_error: str | None = None
    model_loaded: list[str] = field(default_factory=list)
    cuda_dll_dirs_added: int = 0
    queue_depth: int = 0
    queue_status: Literal["not_started", "running", "stopping"] = "not_started"
