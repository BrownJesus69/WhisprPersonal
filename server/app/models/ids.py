"""Validated Firestore document identifiers shared by repositories and schemas."""

import re
from typing import Annotated

from pydantic import AfterValidator

from app.core.errors import AppError, ErrorCode

FIRESTORE_ID_RE = r"^[A-Za-z0-9_-]{1,128}$"


def validate_doc_id(value: str, field: str) -> str:
    if not re.fullmatch(FIRESTORE_ID_RE, value) or re.fullmatch(r"__.*__", value):
        raise AppError(
            ErrorCode.validation_error, "Invalid document identifier.", details={"field": field}
        )
    return value


DocId = Annotated[str, AfterValidator(lambda value: validate_doc_id(value, "id"))]
