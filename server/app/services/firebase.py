"""Local Firebase initialization and lazy Firestore access."""

import logging
from typing import Literal

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore import Client

from app.config import Settings
from app.core.errors import AppError, ErrorCode

FirebaseStatus = Literal["not_configured", "ready", "error"]


class FirebaseService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.status: FirebaseStatus = "not_configured"
        self.error_reason: str | None = None
        self.project_id: str | None = None
        self._app: firebase_admin.App | None = None
        self._client: Client | None = None
        self._initialized = False

    def initialize(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        path = self.settings.firebase_credentials_path
        if path is not None:
            try:
                present = path.is_file()
            except OSError:
                present = False
            if not present:
                self.status, self.error_reason = "error", "credentials_missing"
            else:
                try:
                    cred = credentials.Certificate(str(path))
                except Exception:
                    self.status, self.error_reason = "error", "credentials_invalid"
                else:
                    try:
                        options = (
                            {"projectId": self.settings.firebase_project_id}
                            if self.settings.firebase_project_id
                            else None
                        )
                        self._app = firebase_admin.initialize_app(
                            cred, options=options, name="whisprpersonal"
                        )
                        self.project_id = cred.project_id
                        self.status = "ready"
                    except Exception:
                        self.status, self.error_reason = "error", "init_failed"
        logging.getLogger(__name__).info(
            "Firebase initialization",
            extra={"event": "firebase_init", "status": self.status, "reason": self.error_reason},
        )

    @property
    def app(self) -> firebase_admin.App:
        if self.status != "ready" or self._app is None:
            raise AppError(ErrorCode.auth_not_configured, "Token verification is not configured.")
        return self._app

    def firestore(self) -> Client:
        if self._client is None:
            self._client = firestore.client(
                app=self.app, database_id=self.settings.firebase_database_id
            )
        return self._client

    def close(self) -> None:
        if self._app is not None:
            firebase_admin.delete_app(self._app)
            self._app = None
            self._client = None
            self.status = "not_configured"
