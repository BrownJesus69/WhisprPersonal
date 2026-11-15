"""Request-scoped correlation and pure ASGI access logging."""

import logging
import re
import time
from contextvars import ContextVar
from uuid import uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
session_id_var: ContextVar[str | None] = ContextVar("session_id", default=None)
chunk_id_var: ContextVar[str | None] = ContextVar("chunk_id", default=None)


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        candidate = Headers(scope=scope).get("x-request-id", "")
        request_id = candidate if re.fullmatch(r"[A-Za-z0-9-]{8,64}", candidate) else uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)
        session_token = session_id_var.set(None)
        chunk_token = chunk_id_var.set(None)
        started = time.perf_counter()
        status = 500

        async def wrapped_send(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, wrapped_send)
        finally:
            if scope["type"] == "http":
                logging.getLogger("whisprpersonal.access").info(
                    "HTTP request",
                    extra={
                        "event": "http_request",
                        "method": scope["method"],
                        "path": scope["path"],
                        "status": status,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                        "client_ip": (scope.get("client") or (None,))[0],
                    },
                )
            request_id_var.reset(token)
            session_id_var.reset(session_token)
            chunk_id_var.reset(chunk_token)
