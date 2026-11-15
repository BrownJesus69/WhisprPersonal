import pytest
from pydantic import TypeAdapter

from app.core.errors import AppError
from app.models.ids import DocId, validate_doc_id


def test_valid_id() -> None:
    assert TypeAdapter(DocId).validate_python("abc_DEF-123") == "abc_DEF-123"


@pytest.mark.parametrize("value", ["a/b", "..", ".", "__x__", "", "a b", "a\n", "a" * 129])
def test_invalid_id(value: str) -> None:
    with pytest.raises(AppError) as caught:
        TypeAdapter(DocId).validate_python(value)
    assert caught.value.code == "validation_error"
    assert caught.value.status_code == 422
    with pytest.raises(AppError) as caught:
        validate_doc_id(value, "event_id")
    assert caught.value.details == {"field": "event_id"}
