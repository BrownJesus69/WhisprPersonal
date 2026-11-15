import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import firebase_admin
import pytest
from firebase_admin import credentials, firestore

from app.core.errors import AppError
from app.services.firebase import FirebaseService


def test_unconfigured_and_missing(make_settings: Any, tmp_path: Any) -> None:
    service = FirebaseService(make_settings())
    service.initialize()
    assert service.status == "not_configured"
    with pytest.raises(AppError) as caught:
        _ = service.app
    assert caught.value.code == "auth_not_configured"
    service = FirebaseService(make_settings(firebase_credentials_path=tmp_path / "absent.json"))
    service.initialize()
    assert (service.status, service.error_reason) == ("error", "credentials_missing")


@pytest.mark.parametrize("content", ["invalid-json-canary", '{"type":"authorized_user"}'])
def test_invalid_safe_logs(make_settings: Any, tmp_path: Any, caplog: Any, content: str) -> None:
    path = tmp_path / "invalid.json"
    path.write_text(content)
    with caplog.at_level(logging.INFO):
        service = FirebaseService(make_settings(firebase_credentials_path=path))
        service.initialize()
    assert (service.status, service.error_reason) == ("error", "credentials_invalid")
    assert str(path) not in caplog.text
    assert content not in caplog.text
    assert all(str(path) not in str(record.__dict__) for record in caplog.records)


def test_ready_idempotent_close(make_settings: Any, tmp_path: Any, monkeypatch: Any) -> None:
    path = tmp_path / "fake.json"
    path.write_text("local fixture")
    cert = Mock(return_value=SimpleNamespace(project_id="test-project"))
    app = object()
    init = Mock(return_value=app)
    delete = Mock()
    client = Mock()
    monkeypatch.setattr(credentials, "Certificate", cert)
    monkeypatch.setattr(firebase_admin, "initialize_app", init)
    monkeypatch.setattr(firebase_admin, "delete_app", delete)
    monkeypatch.setattr(firestore, "client", client)
    service = FirebaseService(
        make_settings(firebase_credentials_path=path, firebase_database_id="test-db")
    )
    service.initialize()
    service.initialize()
    assert service.status == "ready"
    assert service.project_id == "test-project"
    init.assert_called_once_with(cert.return_value, options=None, name="whisprpersonal")
    assert service.app is app
    assert service.firestore() is service.firestore()
    client.assert_called_once_with(app=app, database_id="test-db")
    service.close()
    service.close()
    delete.assert_called_once_with(app)


def test_init_failure(make_settings: Any, tmp_path: Any, monkeypatch: Any, caplog: Any) -> None:
    path = tmp_path / "fake.json"
    path.write_text("fixture")
    monkeypatch.setattr(
        credentials, "Certificate", Mock(return_value=SimpleNamespace(project_id="test-project"))
    )
    monkeypatch.setattr(firebase_admin, "initialize_app", Mock(side_effect=RuntimeError(str(path))))
    with caplog.at_level(logging.INFO):
        service = FirebaseService(make_settings(firebase_credentials_path=path))
        service.initialize()
    assert service.error_reason == "init_failed"
    assert str(path) not in caplog.text
