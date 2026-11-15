"""Offline future integrations and opt-in verifier enforcement."""

from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.integrations import integration_status
from app.integrations.app_check import DisabledAppCheck
from app.integrations.calendar import DisabledCalendar
from app.integrations.cloud_whisper import DisabledCloudWhisper
from app.integrations.drive import DisabledDrive
from app.integrations.fcm import DisabledFCM
from app.integrations.gmail import DisabledGmail
from app.integrations.web_search import DisabledWebSearch


@pytest.mark.anyio
@pytest.mark.parametrize("flag", [False, True])
async def test_stubs_never_use_transport(flag: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    def reject(request: httpx.Request) -> httpx.Response:
        pytest.fail("A disabled integration attempted a network request")

    async with httpx.AsyncClient(transport=httpx.MockTransport(reject)) as client:
        # Catch any client use, even if a later stub constructs its own transport.
        send = AsyncMock(side_effect=client.send)
        monkeypatch.setattr(httpx.AsyncClient, "send", send)
        for stub, methods in [
            (DisabledCalendar(flag), ["create_event", "list_events"]),
            (DisabledDrive(flag), ["upload_export"]),
            (DisabledGmail(flag), ["send_brief"]),
            (DisabledFCM(flag), ["send_push"]),
            (DisabledWebSearch(flag), ["enrich"]),
            (DisabledCloudWhisper(flag), ["transcribe"]),
        ]:
            expected = stub.status()
            assert expected["enabled"] is False
            assert expected["status"] == ("not_configured" if flag else "disabled")
            assert expected["docs"].startswith("docs/integrations.md#")
            for method in methods:
                assert await getattr(stub, method)() == expected
        verifier = DisabledAppCheck(flag)
        assert verifier.configured is False
        assert await verifier.verify(None) is False
        assert verifier.status()["enabled"] is False
        send.assert_not_called()


def test_flags_and_placeholders_default_off(make_settings: Any) -> None:
    settings = make_settings()
    for key, status in integration_status(settings).items():
        assert getattr(settings, f"feature_{key}") is False
        assert status["enabled"] is False
        assert status["status"] == "disabled"
    for name in [
        "calendar_account",
        "drive_folder_id",
        "gmail_account",
        "app_check_project_id",
        "fcm_project_id",
        "web_search_api_key",
        "cloud_whisper_api_key",
        "cloud_whisper_model",
    ]:
        assert getattr(settings, name) is None
    assert "feature_translation" not in type(settings).model_fields


def test_empty_placeholders_and_identifier_redaction(make_settings: Any) -> None:
    settings = make_settings(calendar_account="", web_search_api_key="", cloud_whisper_model="")
    assert settings.calendar_account is None
    assert settings.web_search_api_key is None
    assert settings.cloud_whisper_model is None
    settings = make_settings(calendar_account="account-sentinel", drive_folder_id="folder-sentinel")
    summary = settings.safe_summary()
    assert summary["calendar_account_set"] is True
    assert "account-sentinel" not in str(summary)
    assert "folder-sentinel" not in str(summary)


def test_health_and_diagnostics_inventory(phase3_client: TestClient) -> None:
    health = phase3_client.get("/health").json()["integrations"]
    assert set(health) == {
        "calendar",
        "drive",
        "gmail",
        "app_check",
        "fcm",
        "web_search",
        "cloud_whisper",
    }
    assert all(not status["enabled"] for status in health.values())
    response = phase3_client.get("/api/v1/diagnostics")
    assert response.status_code == 200
    assert response.json()["integrations"] == health


@pytest.mark.parametrize(
    "flag,configured,expected",
    [
        (False, False, 200),
        (True, False, 200),
        (False, True, 200),
        (True, True, 401),
    ],
)
def test_app_check_only_enforces_both_gates(
    phase3_client: TestClient, flag: bool, configured: bool, expected: int
) -> None:
    state = phase3_client.app.state
    state.settings.feature_app_check = flag
    verifier = AsyncMock()
    verifier.configured = configured
    verifier.verify.return_value = False
    state.app_check_verifier = verifier
    response = phase3_client.get("/api/v1/auth/check")
    assert response.status_code == expected
    assert verifier.verify.call_count == int(flag and configured)
    if flag and configured:
        verifier.verify.return_value = True
        assert phase3_client.get("/api/v1/auth/check").status_code == 200


def test_enabled_unconfigured_app_check_is_nonblocking(phase3_client: TestClient) -> None:
    state = phase3_client.app.state
    state.settings.feature_app_check = True
    state.app_check_verifier = DisabledAppCheck(True)
    assert phase3_client.get("/api/v1/auth/check").status_code == 200
    assert (
        phase3_client.get("/health").json()["integrations"]["app_check"]["status"]
        == "not_configured"
    )
