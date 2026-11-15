import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from google.api_core.exceptions import ServiceUnavailable
from google.auth.exceptions import RefreshError, TransportError

from app.core.errors import AppError, error_response
from app.security.auth import VerifiedUser
from app.security.ownership import (
    FirestoreEventRepository,
    require_event_owner,
    require_owner,
)


def test_owner_and_hidden_missing() -> None:
    user = VerifiedUser("testuser", None, {})
    require_owner("testuser", user)
    bodies = []
    for owner in ("another", None):
        repo = SimpleNamespace(get_event_owner=AsyncMock(return_value=owner))
        with pytest.raises(AppError) as caught:
            asyncio.run(require_event_owner("event1", user, repo))
        assert caught.value.code == "not_found"
        assert caught.value.status_code == 404
        bodies.append(error_response(caught.value, "same-request").body)
    assert bodies[0] == bodies[1]
    repo = SimpleNamespace(get_event_owner=AsyncMock(return_value="testuser"))
    asyncio.run(require_event_owner("event1", user, repo))


@pytest.mark.parametrize("event_id", ["a/b", "..", "__x__", "a" * 129])
def test_invalid_before_repository(event_id: str) -> None:
    repo = SimpleNamespace(get_event_owner=AsyncMock())
    with pytest.raises(AppError) as caught:
        asyncio.run(require_event_owner(event_id, VerifiedUser("testuser", None, {}), repo))
    assert caught.value.code == "validation_error"
    repo.get_event_owner.assert_not_called()
    service = SimpleNamespace(firestore=Mock())
    with pytest.raises(AppError):
        asyncio.run(FirestoreEventRepository(service).get_event_owner(event_id))
    service.firestore.assert_not_called()


@pytest.mark.parametrize(
    "exception",
    [
        ServiceUnavailable("sensitive"),
        TimeoutError("sensitive"),
        TransportError("sensitive"),  # offline: access-token refresh cannot reach Google
        RefreshError("sensitive"),
    ],
)
def test_firestore_unavailable(exception: Exception) -> None:
    client = Mock()
    client.collection.return_value.document.return_value.get.side_effect = exception
    service = SimpleNamespace(firestore=Mock(return_value=client))
    with pytest.raises(AppError) as caught:
        asyncio.run(FirestoreEventRepository(service).get_event_owner("event1"))
    assert caught.value.code == "firestore_unavailable"
    assert caught.value.status_code == 503
    assert "sensitive" not in error_response(caught.value).body.decode()


def test_fail_fast_after_firestore_failure_then_recovers() -> None:
    client = Mock()
    get = client.collection.return_value.document.return_value.get
    get.side_effect = ServiceUnavailable("down")
    repo = FirestoreEventRepository(SimpleNamespace(firestore=Mock(return_value=client)))
    for _ in range(3):
        with pytest.raises(AppError):
            asyncio.run(repo.get_event_owner("event1"))
    assert get.call_count == 1  # later calls skipped the network entirely
    repo._down_until = 0.0  # window elapsed
    get.side_effect = None
    get.return_value = SimpleNamespace(exists=True, to_dict=lambda: {"ownerId": "u"})
    assert asyncio.run(repo.get_event_owner("event1")) == "u"


@pytest.mark.parametrize(
    ("exists", "data", "expected"),
    [
        (True, {"ownerId": "testuser"}, "testuser"),
        (False, None, None),
        (True, {}, None),
    ],
)
def test_firestore_projection(exists: bool, data: Any, expected: str | None) -> None:
    client = Mock()
    get = client.collection.return_value.document.return_value.get
    get.return_value = SimpleNamespace(exists=exists, to_dict=lambda: data)
    service = SimpleNamespace(firestore=Mock(return_value=client))
    assert asyncio.run(FirestoreEventRepository(service).get_event_owner("event1")) == expected
    client.collection.assert_called_once_with("events")
    client.collection.return_value.document.assert_called_once_with("event1")
    get.assert_called_once_with(field_paths=["ownerId"])
