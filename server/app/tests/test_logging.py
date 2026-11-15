import io
import json
import logging
import secrets
from typing import Any

from app.core.logging import RedactingFilter, StructuredFormatter, configure_logging
from app.core.request_context import request_id_var


def test_json_context_and_redaction(make_settings: Any) -> None:
    settings = make_settings()
    configure_logging(settings)
    output = io.StringIO()
    root = logging.getLogger()
    handler = root.handlers[0]
    handler.setStream(output)
    private = settings.server_shared_secret.get_secret_value()
    bearer = secrets.token_urlsafe(24)
    provider = "gsk_" + secrets.token_urlsafe(24)
    pem = "-----BEGIN RSA PRIVATE KEY-----\nprivate-data\n-----END RSA PRIVATE KEY-----"
    token = request_id_var.set("test-request-123")
    try:
        root.info(
            "Bearer %s %s %s %s",
            bearer,
            provider,
            pem,
            private,
            extra={"event": "test", "header": f"X-WhisprPersonal-Server-Key: {private}"},
        )
    finally:
        request_id_var.reset(token)
    line = output.getvalue()
    payload = json.loads(line)
    assert payload["request_id"] == "test-request-123"
    assert payload["event"] == "test"
    for value in (private, bearer, provider, "private-data"):
        assert value not in line
    assert "[REDACTED]" in line


def test_exception_extra_redaction() -> None:
    redactor = RedactingFilter()
    formatter = StructuredFormatter(redactor)
    record = logging.makeLogRecord(
        {
            "msg": "failure",
            "extra_data": "X-WhisprPersonal-Server-Key: sensitive-header-value",
        }
    )
    assert "sensitive-header-value" not in formatter.format(record)
