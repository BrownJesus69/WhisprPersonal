"""Offline fixtures: explicit settings never load an environment file."""

import secrets
import socket
from collections.abc import Iterator
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.main import create_app
from app.security.auth import VerifiedUser


class FakeTokenVerifier:
    async def verify(self, id_token: str) -> VerifiedUser:
        if id_token != "good-token":  # noqa: S105 -- prescribed fake verifier input
            raise AppError(ErrorCode.invalid_auth_token, "Token is invalid.")
        return VerifiedUser(uid="user-1", email=None, claims={})


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    original_connect = socket.socket.connect
    original_pair = socket.socketpair
    internal_pair: ContextVar[bool] = ContextVar("internal_pair", default=False)

    def blocked(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("Network access is forbidden in tests")

    def connect(sock: socket.socket, address: Any) -> None:
        if internal_pair.get():
            original_connect(sock, address)
        else:
            blocked()

    def socketpair(*args: Any, **kwargs: Any) -> tuple[socket.socket, socket.socket]:
        # Windows asyncio implements its internal wakeup pipe with a loopback socketpair.
        token = internal_pair.set(True)
        try:
            return original_pair(*args, **kwargs)
        finally:
            internal_pair.reset(token)

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "socketpair", socketpair)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


@pytest.fixture
def make_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)

    def make(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "models_dir": tmp_path / "models",
            "data_dir": tmp_path / "data",
            "gpu_detection": "off",
            "whisper_preload": False,
            "server_shared_secret": secrets.token_urlsafe(36),
            "groq_api_key": None,
            "sambanova_api_key": None,
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)

    return make


@pytest.fixture
def settings(make_settings: Any) -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, client=("127.0.0.1", 50000)) as test_client:
        yield test_client


class FakeFirebaseService:
    """Ready local service; never opens files or calls SDK initialization."""

    status = "ready"
    error_reason = None
    project_id = "test-project"
    app = object()

    def initialize(self) -> None:
        pass

    def close(self) -> None:
        pass


@pytest.fixture
def fake_firebase() -> FakeFirebaseService:
    return FakeFirebaseService()


@pytest.fixture
def phase3_client(settings: Settings) -> Iterator[TestClient]:
    from app.tests.fakes import FakeEngine, FakeEventRepo, FakeFirestoreSync

    app = create_app(settings, token_verifier=FakeTokenVerifier())
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        client.headers.update(
            {
                "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
                "Authorization": "Bearer good-token",
            }
        )
        app.state.event_repository = FakeEventRepo()
        app.state.engine = app.state.worker.engine = FakeEngine()
        app.state.firestore_sync = app.state.worker.sync = FakeFirestoreSync()
        yield client
