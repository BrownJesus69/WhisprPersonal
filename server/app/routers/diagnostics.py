"""Authenticated diagnostics with a per-user rate limit."""

import platform
from typing import Any

from fastapi import APIRouter, Depends, Request

from app.routers.health import build_health
from app.security.rate_limit import authenticated_user

router = APIRouter()


@router.get("/api/v1/diagnostics", dependencies=[Depends(authenticated_user)])
async def diagnostics(request: Request) -> dict[str, Any]:
    summary = request.app.state.settings.safe_summary()
    counts = await request.app.state.store.rows(
        "SELECT status,COUNT(*) AS n FROM chunks GROUP BY status"
    )
    recent = await request.app.state.store.rows(
        "SELECT processing_ms,end_ms-start_ms AS duration FROM chunks WHERE status='done' "
        "ORDER BY updated_at DESC LIMIT 50"
    )
    factors = [row["processing_ms"] / row["duration"] for row in recent if row["duration"] > 0]
    return {
        **build_health(request).model_dump(mode="json"),
        "python_version": platform.python_version(),
        "platform": platform.system(),
        "config": summary,
        "chunk_counts": {
            status: next((row["n"] for row in counts if row["status"] == status), 0)
            for status in ("queued", "processing", "done", "failed")
        },
        "average_real_time_factor": sum(factors) / len(factors) if factors else None,
        "cuda_dll_dirs_added": request.app.state.server_state.cuda_dll_dirs_added,
        "limits": {
            key: value for key, value in summary.items() if key.startswith(("max_", "rate_limit_"))
        },
    }
