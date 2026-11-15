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
    return {
        **build_health(request).model_dump(mode="json"),
        "python_version": platform.python_version(),
        "platform": platform.system(),
        "config": summary,
        "limits": {
            key: value for key, value in summary.items() if key.startswith(("max_", "rate_limit_"))
        },
    }
