"""Bound declared and streamed HTTP bodies before downstream processing."""

import re

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings
from app.core.errors import AppError, ErrorCode, send_error


class BodyLimitExceeded(Exception):
    """Internal control flow; never exposed to clients."""


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = (
            self.settings.max_chunk_upload_bytes
            if re.fullmatch(r"/api/v1/sessions/[^/]+/chunks", scope["path"])
            else self.settings.max_json_body_bytes
        )
        error = AppError(ErrorCode.payload_too_large, "Request body exceeds the size limit.")
        lengths = Headers(scope=scope).getlist("content-length")
        try:
            if len(lengths) > 1 or (lengths and int(lengths[0]) < 0):
                raise ValueError
            if lengths and int(lengths[0]) > limit:
                await send_error(scope, receive, send, error)
                return
        except ValueError:
            await send_error(
                scope,
                receive,
                send,
                AppError(ErrorCode.bad_request, "Invalid Content-Length header."),
            )
            return
        total = 0
        exceeded = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal total, exceeded
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    exceeded = True
                    raise BodyLimitExceeded
            return message

        async def wrapped_send(message: Message) -> None:
            nonlocal response_started
            # Framework body parsers may translate receive errors into HTTP 400.
            if exceeded and not response_started:
                raise BodyLimitExceeded
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, wrapped_send)
        except BodyLimitExceeded:
            if response_started:
                raise
            await send_error(scope, receive, send, error)
