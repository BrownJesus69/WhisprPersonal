"""Authenticated diagnostics; disabled verifier fails closed in Phase 1."""

import platform
from typing import Any

from fastapi import APIRouter, Depends, Request

from app.routers.health import build_health
from app.security.auth import require_auth

router = APIRouter()


@router.get("/api/v1/diagnostics", dependencies=[Depends(require_auth)])
async def diagnostics(request: Request) -> dict[str, Any]:
    summary = request.app.state.settings.safe_summary()
    return {
        **build_health(request).model_dump(mode="json"),
        "python_version": platform.python_version(),
        "platform": platform.system(),
        "config": summary,
        "limits": {
            key: value for key, value in summary.items() if key.startswith(("max_", "rate_limit_"))
        },
    }
