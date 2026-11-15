"""Mutable process state owned by app.state; extended by Phase 3."""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from app.schemas.health import GpuInfo


@dataclass
class ServerState:
    started_at: datetime
    gpu: GpuInfo
    model_status: Literal["not_loaded", "loading", "ready", "error"] = "not_loaded"
    model_name: str | None = None
    queue_depth: int = 0
    queue_status: Literal["not_started", "running", "stopping"] = "not_started"
