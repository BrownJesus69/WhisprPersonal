"""Structured stdout logs with redaction at the final serialization boundary."""

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

from pydantic import SecretStr

from app.config import Settings
from app.core.request_context import chunk_id_var, request_id_var, session_id_var


class RedactingFilter(logging.Filter):
    def __init__(self, secrets: tuple[str, ...] = ()) -> None:
        super().__init__()
        self.secrets = tuple(value for value in secrets if value)

    def redact(self, value: str) -> str:
        for secret in self.secrets:
            value = value.replace(secret, "[REDACTED]")
        value = re.sub(r"Bearer\s+[^\s\"',;]+", "Bearer [REDACTED]", value, flags=re.I)
        value = re.sub(
            r"(X-WhisprPersonal-Server-Key[\"']?\s*[:=]\s*[\"']?)[^\s\"',;}]+",
            r"\1[REDACTED]",
            value,
            flags=re.I,
        )
        value = re.sub(
            r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
            "[REDACTED PRIVATE KEY]",
            value,
            flags=re.S,
        )
        return re.sub(r"(?:gsk_|sk-|AIza)[A-Za-z0-9_-]{8,}", "[REDACTED]", value)

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self.redact(record.getMessage())
        record.args = ()
        return True


class StructuredFormatter(logging.Formatter):
    def __init__(self, redactor: RedactingFilter, console: bool = False) -> None:
        super().__init__()
        self.redactor = redactor
        self.console = console
        self.standard_keys = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update({k: v for k, v in record.__dict__.items() if k not in self.standard_keys})
        for name, var in (
            ("request_id", request_id_var),
            ("session_id", session_id_var),
            ("chunk_id", chunk_id_var),
        ):
            if var.get() is not None:
                payload[name] = var.get()
        if record.exc_info:
            payload["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
            # Exceptions may contain audio paths, transcript content or SDK credentials.
            # Keep the exception type, never its message or stack.

        # Redact before JSON encoding so multiline PEM blocks remain recognizable.
        def clean(value: Any) -> Any:
            if isinstance(value, dict):
                return {self.redactor.redact(str(k)): clean(v) for k, v in value.items()}
            if isinstance(value, (list, tuple)):
                return [clean(v) for v in value]
            if isinstance(value, str):
                return self.redactor.redact(value)
            if value is None or isinstance(value, (int, float, bool)):
                return value
            return self.redactor.redact(str(value))

        payload = clean(payload)
        if self.console:
            return " ".join(f"{key}={json.dumps(value)}" for key, value in payload.items())
        return json.dumps(payload, ensure_ascii=True)


def configure_logging(settings: Settings) -> None:
    secrets = tuple(
        value.get_secret_value()
        for name in type(settings).model_fields
        if isinstance(value := getattr(settings, name), SecretStr)
    )
    redactor = RedactingFilter(secrets)
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(redactor)
    handler.setFormatter(StructuredFormatter(redactor, settings.log_format == "console"))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level.upper())
    # Uvicorn's own access log includes query strings. Use our safe access line instead.
    logging.getLogger("uvicorn.access").disabled = True
    # Inference library warnings may include local model paths or decoder data.
    # Our engine reports only safe codes, timings and IDs instead.
    logging.getLogger("faster_whisper").disabled = True
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
