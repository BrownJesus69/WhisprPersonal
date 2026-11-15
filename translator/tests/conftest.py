"""Network denied, including accidental HF lookups; asyncio socketpair is local machinery."""

import socket
from contextvars import ContextVar
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    original_connect, original_pair = socket.socket.connect, socket.socketpair
    internal: ContextVar[bool] = ContextVar("internal", default=False)

    def blocked(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("Network forbidden")

    def connect(sock: Any, address: Any) -> None:
        if internal.get():
            original_connect(sock, address)
        else:
            blocked()

    def pair(*args: Any, **kwargs: Any) -> Any:
        token = internal.set(True)
        try:
            return original_pair(*args, **kwargs)
        finally:
            internal.reset(token)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.setattr(socket, "socketpair", pair)
