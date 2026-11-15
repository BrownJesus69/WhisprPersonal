# Phase 2 — Firebase integration (server)

**Working directory:** `E:\Whispr` (monorepo root). Server code: `E:\Whispr\server`.
**Read `E:\Whispr\AGENTS.md` first and obey every non-negotiable in it.** The project is
named **WhisprPersonal** (header `X-WhisprPersonal-Server-Key`, env prefix `WHISPRPERSONAL_`
for launcher-only vars). Phase 1 is committed; read the existing code before changing it and
follow its patterns (pure-ASGI middleware, `AppError` + `ErrorCode`, `SecretStr`,
`safe_summary()`, offline `conftest.py` with the `no_network` autouse fixture).

## Goal

Verify Firebase ID tokens with the Firebase Admin SDK on every protected request, keep the
shared-secret-first order, add owner-based authorization helpers backed by Firestore (Admin
SDK), and ship Firestore security rules + indexes for the data model below.

## Out of scope (do NOT implement)

Sessions/chunks/transcription endpoints (Phase 3), Android (Phase 4+), App Check enforcement
(Phase 10), any offline-auth workaround (architect decision pending — see "Known constraint").

## Facts verified by the architect (installed in `server/.venv`, do not reinstall)

- `firebase-admin==7.8.0` (pulls `google-cloud-firestore==2.34.1`, `google-auth==2.62.2`).
  Add exactly `firebase-admin==7.8.0` to `requirements.txt`.
- `firebase_admin.auth.verify_id_token(id_token, app=None, check_revoked=False,
  clock_skew_seconds=0)` — synchronous; fetches Google public certs over HTTPS (in-memory cache
  only). Must run via `asyncio.to_thread`.
- `firebase_admin.initialize_app(credential=None, options=None, name='[DEFAULT]')`;
  `firebase_admin.credentials.Certificate(path)`; `firebase_admin.firestore.client(app=None,
  database_id=None)`.
- Exception classes in `firebase_admin.auth` (MRO matters — catch subclasses first):
  `ExpiredIdTokenError(message, cause)` and `RevokedIdTokenError(message)` both subclass
  `InvalidIdTokenError(message, cause=None, http_response=None)`;
  `UserDisabledError(message, cause=None, http_response=None)`;
  `CertificateFetchError(message, cause)`. Malformed tokens can also raise `ValueError`.

## Scope — files

Modify:
```
server/requirements.txt          # + firebase-admin==7.8.0
server/app/config.py             # new settings (below)
server/app/core/errors.py        # new codes
server/app/main.py               # lifespan: init FirebaseService, choose verifier
server/app/schemas/health.py     # FirebaseInfo / AuthInfo statuses
server/app/routers/health.py
server/app/routers/diagnostics.py  # add per-user rate limit dependency
server/app/security/auth.py      # allowlist enforcement hook (see below)
server/.env.example
server/app/tests/conftest.py     # helpers for fake Firebase (keep no_network intact)
docs/api.md, docs/setup.md, docs/security.md, docs/architecture.md, README.md (phase table)
```
Create:
```
server/app/services/firebase.py
server/app/security/firebase_verifier.py
server/app/security/ownership.py
server/app/models/ids.py
server/app/routers/auth.py
server/app/tests/test_firebase_service.py
server/app/tests/test_firebase_verifier.py
server/app/tests/test_ownership.py
server/app/tests/test_auth_check.py
server/app/tests/test_ids.py
firebase.json
firebase/firestore.rules
firebase/firestore.indexes.json
firebase/README.md
```

## Design

### config.py — new fields
- `firebase_check_revoked: bool = False` (True adds a network call per request; document it).
- `firebase_clock_skew_s: int = Field(5, ge=0, le=60)`.
- `firebase_database_id: str | None = None` (None = "(default)").
- `auth_allowed_uids: Annotated[list[str], NoDecode] = []` — comma-separated; empty = any
  verified user of this Firebase project. Validate each uid matches `^[A-Za-z0-9]{1,128}$`.
- `auth_allowed_emails: Annotated[list[str], NoDecode] = []` — comma-separated, lower-cased;
  matched only when the token has `email_verified == True`.
- `safe_summary()`: allowlists appear only as counts (`auth_allowed_uids_count`), never values.

### core/errors.py — new codes
`auth_token_expired` (401; client should refresh its ID token and retry once),
`auth_unavailable` (503; cannot reach Google to fetch signing certs),
`account_not_allowed` (403; verified user is not in the allowlist),
`firestore_unavailable` (503). Keep `forbidden` (403). Use `not_found` (404) for resources the
caller does not own (no existence leak).

### services/firebase.py
```python
FirebaseStatus = Literal["not_configured", "ready", "error"]

class FirebaseService:
    status: FirebaseStatus
    error_reason: str | None      # safe short code: "credentials_missing",
                                  # "credentials_invalid", "init_failed"; never paths/messages
    project_id: str | None        # from the service account; not secret
    def __init__(self, settings: Settings) -> None
    def initialize(self) -> None   # sync; idempotent; called from lifespan via to_thread
    @property app -> firebase_admin.App   # raises AppError(auth_not_configured) if not ready
    def firestore(self) -> google.cloud.firestore.Client  # lazy, cached; app must be ready
    def close(self) -> None        # firebase_admin.delete_app(app) if initialized
```
- No credentials path → `not_configured`. Path set but not a file → `error/credentials_missing`.
- Use a **named** app (`name="whisprpersonal"`) so tests and other code never collide with the
  default app; options `{"projectId": settings.firebase_project_id}` only when set.
- Wrap `credentials.Certificate(path)` and `initialize_app` in `try/except Exception` →
  `error/credentials_invalid` or `error/init_failed`. Log `event="firebase_init"` with status
  and reason only — **never** the exception message (it can echo file contents/paths), never
  the path. `project_id` comes from `cred.project_id`.
- Must not make network calls during `initialize()` (Certificate + initialize_app are local).

### security/firebase_verifier.py
```python
class FirebaseTokenVerifier:  # implements security.auth.TokenVerifier
    def __init__(self, service: FirebaseService, settings: Settings,
                 verify_fn: Callable[..., Mapping[str, Any]] | None = None) -> None
    async def verify(self, id_token: str) -> VerifiedUser
```
- `verify_fn` defaults to `firebase_admin.auth.verify_id_token`; injectable for tests.
- Reject tokens longer than 8192 chars or containing whitespace before calling Firebase →
  `invalid_auth_token`.
- Call `await asyncio.to_thread(verify_fn, id_token, app=service.app,
  check_revoked=settings.firebase_check_revoked,
  clock_skew_seconds=settings.firebase_clock_skew_s)`.
- Exception mapping (in this order):
  `ExpiredIdTokenError` → `auth_token_expired`;
  `RevokedIdTokenError` → `invalid_auth_token` ("Sign-in was revoked. Sign in again.");
  `UserDisabledError` → `account_not_allowed`;
  `InvalidIdTokenError` → `invalid_auth_token`;
  `CertificateFetchError` → `auth_unavailable`;
  `ValueError` → `invalid_auth_token`;
  any other `Exception` → `auth_unavailable` (log `event="auth_verify_error"` with
  `exc_type` only). Never include the token or SDK message in responses or logs.
- Build `VerifiedUser(uid=claims["uid"], email=claims.get("email"), claims=<filtered>)`; keep
  only non-sensitive claims: `uid`, `email`, `email_verified`, `auth_time`, `exp`, `iat`,
  `firebase.sign_in_provider`. Missing/empty uid → `invalid_auth_token`.
- After verification enforce the allowlist (helper in `security/auth.py`,
  `enforce_allowlist(user, settings)`): if both lists empty → allow; else allow when uid in
  `auth_allowed_uids` OR (email_verified and email.lower() in `auth_allowed_emails`); otherwise
  `account_not_allowed`. Log `event="auth_denied_allowlist"` with uid only.

### main.py lifespan
- After settings/state: `service = FirebaseService(settings)`; `await
  asyncio.to_thread(service.initialize)`; store on `app.state.firebase`.
- `app.state.token_verifier = FirebaseTokenVerifier(service, settings) if service.status ==
  "ready" else DisabledTokenVerifier()` (fail closed).
- If ready and both allowlists are empty, log a WARNING `event="auth_allowlist_empty"`
  ("any user of this Firebase project with the server key can use this server").
- On shutdown call `service.close()` (in `finally`).
- `create_app` must still work with no credentials and no network.
- Tests need to inject a fake service/verifier: support `create_app(settings,
  firebase_service=None, token_verifier=None)` overrides (used only by tests).

### models/ids.py
- `FIRESTORE_ID_RE = r"^[A-Za-z0-9_-]{1,128}$"`; `def validate_doc_id(value: str, field:
  str) -> str` raising `AppError(validation_error, details={"field": field})`.
- Pydantic `Annotated[str, AfterValidator(...)]` alias `DocId` for request schemas (Phase 3+).
  Rejects `/`, `..`, `.`, whitespace, `__.*__` (Firestore-reserved), empty, >128.

### security/ownership.py
```python
class EventOwnershipRepository(Protocol):
    async def get_event_owner(self, event_id: str) -> str | None   # None = not found

class FirestoreEventRepository:     # Admin SDK; bypasses rules, so WE enforce ownership
    def __init__(self, service: FirebaseService) -> None
    async def get_event_owner(self, event_id: str) -> str | None
        # validate_doc_id; to_thread(client.collection("events").document(id).get(
        #   field_paths=["ownerId"])); google.api_core exceptions / timeouts ->
        #   AppError(firestore_unavailable); never log document data.

async def require_event_owner(event_id: str, user: VerifiedUser,
                              repo: EventOwnershipRepository) -> None
    # missing OR owner != user.uid -> AppError(not_found, "Event not found.")  (same response)

def require_owner(resource_owner_id: str | None, user: VerifiedUser) -> None
    # generic helper for server-side records (Phase 3 local sessions); same 404 semantics
```
- Store the repository on `app.state.event_repository` (Firestore-backed when Firebase is
  ready, else a repository that raises `auth_not_configured`). Provide a FastAPI dependency
  `get_event_repository(request)`.

### routers/auth.py
`GET /api/v1/auth/check` — dependencies: `require_auth` then `per_user_rate_limit`. Returns
`{"uid": str, "email": str | None, "email_verified": bool, "sign_in_provider": str | None,
"server_version": str}`. This is the app's "credentials work" probe for the Connect-laptop
screen (Phase 4). Make `per_user_rate_limit` reuse the already-resolved user (no double
verification): restructure so the endpoint depends on a single `authenticated_user`
dependency = require_auth + per-user rate limit, verifying the token exactly once per request.
Apply the same dependency to `/api/v1/diagnostics`.

### Health
- `FirebaseInfo`: `credentials_present: bool`, `status: Literal["not_configured","ready",
  "error"]`, `error_reason: str | None` (safe code only), `project_id_set: bool` (no value).
- `AuthInfo`: `shared_secret_configured: bool`, `token_verification:
  Literal["disabled","firebase"]`, `allowlist_enabled: bool`, `check_revoked: bool`.
- `status == "degraded"` rules unchanged (model/queue); Firebase errors do not affect it in
  this phase but are visible.

### Firestore rules (`firebase/firestore.rules`, rules_version = '2')
Data model (exact field names):
```
users/{uid}: displayName, createdAt, defaultServerUrl, preferences
events/{eventId}: ownerId, title, description, location, startTime, endTime, agenda,
  speakers[], languages[], languageMode, status, createdAt, updatedAt, consentVersion,
  privacyMode
events/{eventId}/sessions/{sessionId}: ownerId, status, model, languageMode,
  detectedLanguages[], startedAt, endedAt, durationMs, serverSessionId, transcriptStatus, error
events/{eventId}/sessions/{sessionId}/chunks/{chunkId}: sequence, startMs, endMs,
  uploadStatus, transcriptionStatus, detectedLanguage, languageConfidence, languageSource,
  userOverride, rawText, polishedText, error, createdAt, updatedAt
events/{eventId}/notes/{noteId}: ownerId, source, text, timestampMs, speaker, createdAt,
  updatedAt
events/{eventId}/briefs/{briefId}: ownerId, type, status, provider, model, generatedText,
  structuredBrief, createdAt, updatedAt
```
Rules:
- Default deny everything (`match /{document=**} { allow read, write: if false; }` is implicit
  — do not add a permissive wildcard).
- `users/{uid}`: read/write only if `request.auth.uid == uid`; no `delete` of others.
- `events/{eventId}`: `read`/`delete` if `resource.data.ownerId == request.auth.uid`;
  `create` if `request.resource.data.ownerId == request.auth.uid` and required keys
  `ownerId,title,status,createdAt` exist and `status in ['draft','active','processing',
  'completed','failed']` and `privacyMode in ['local_only','cloud_ai']` and
  `title is string && title.size() <= 200`; `update` additionally requires
  `request.resource.data.ownerId == resource.data.ownerId` (owner immutable) and the same
  enum checks. `list` queries must be constrained by ownerId (rules evaluate per-doc; this works
  because `resource.data.ownerId == request.auth.uid` applies to list).
- Subcollections (`sessions`, `notes`, `briefs`, and `sessions/{s}/chunks`): access only if the
  parent event's owner is the caller, via a helper
  `function isEventOwner(eventId) { return request.auth != null && get(/databases/$(database)
  /documents/events/$(eventId)).data.ownerId == request.auth.uid; }`. For docs that carry
  `ownerId` (sessions, notes, briefs) also require `request.resource.data.ownerId ==
  request.auth.uid` on create and immutability on update. Chunks: owner read; owner write
  allowed (client may sync upload status) with `rawText`/`polishedText` size <= 20000.
- Explicitly forbid any field named like a secret: reject writes whose keys include
  `apiKey`, `serverKey`, `privateKey`, `secret`, `token` (use
  `request.resource.data.keys().hasAny([...])`).
- Comment at top: Admin SDK (the laptop server) bypasses these rules; the server enforces
  ownership itself (security/ownership.py).

### `firebase/firestore.indexes.json`
Composite indexes (collection scope):
- `events`: `ownerId ASC, updatedAt DESC` (home list).
- `events`: `ownerId ASC, status ASC, updatedAt DESC` (resume unfinished / status filter).
- `notes`: `ownerId ASC, timestampMs ASC`.
- `briefs`: `ownerId ASC, createdAt DESC`.
Add `"fieldOverrides": []`.

### `firebase.json` (repo root)
`{"firestore": {"rules": "firebase/firestore.rules", "indexes":
"firebase/firestore.indexes.json"}}`.
`firebase/README.md`: how to deploy with the Firebase CLI
(`firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>`), how
to test rules with the emulator, and that no credentials are needed in the repo for this.
Do not hardcode the project id anywhere.

### .env.example additions
`FIREBASE_CHECK_REVOKED=false`, `FIREBASE_CLOCK_SKEW_S=5`, `FIREBASE_DATABASE_ID=`,
`AUTH_ALLOWED_UIDS=`, `AUTH_ALLOWED_EMAILS=` with comments (recommend setting your own uid
after first sign-in; it is shown by `/api/v1/auth/check`).

## Tests (all offline; never import credentials; never call the real SDK network paths)

- `test_firebase_service.py`: no path → `not_configured`; missing file → `error/
  credentials_missing`; a tmp file with invalid JSON → `error/credentials_invalid`; a tmp
  JSON with `{"type":"authorized_user"}` → error; success path by monkeypatching
  `firebase_admin.credentials.Certificate` and `firebase_admin.initialize_app` with fakes →
  `ready`, project_id set; idempotent initialize; `close()` calls `delete_app`; log output
  never contains the tmp path or file contents (use `caplog`).
- `test_firebase_verifier.py`: injectable `verify_fn` fakes for: valid claims → VerifiedUser
  with filtered claims; each exception class above → correct error code/status (construct real
  `firebase_admin.auth` exception instances with the constructor signatures listed earlier);
  token >8192 chars or with whitespace → `invalid_auth_token` without calling `verify_fn`;
  missing uid → invalid; `check_revoked` and `clock_skew_seconds` passed through; response
  bodies and logs never contain the token string.
- Allowlist: uid match allowed; verified-email match allowed (case-insensitive);
  unverified email not allowed; neither → 403 `account_not_allowed`; empty lists → allowed.
- `test_auth_check.py`: end-to-end via `create_app(settings, token_verifier=<FirebaseToken
  Verifier with fake verify_fn and a fake ready service>)`: missing server key → 401
  `missing_server_key` and `verify_fn` NOT called; good key + good token → 200 with uid;
  expired → 401 `auth_token_expired`; per-user rate limit (limit 2/min) → third call 429;
  token verified exactly once per request (count calls).
- `test_ownership.py`: fake repository: owner → passes; other owner → 404 `not_found`;
  missing → identical 404 body except request_id; repository raising
  `google.api_core.exceptions.ServiceUnavailable` inside `FirestoreEventRepository` (fake client)
  → 503 `firestore_unavailable`; invalid event id (`"a/b"`, `".."`, `"__x__"`, 129 chars) →
  422 `validation_error` without touching the repo.
- `test_ids.py`: DocId accepts `abc_DEF-123`, rejects the invalid cases above.
- Update `test_health.py`: firebase `not_configured` by default; `ready` with injected fake
  service; `token_verification == "firebase"` when ready; no project id / path / uid values in
  the body.
- Keep every Phase 1 test passing (update only where the contract intentionally changed, e.g.
  `FirebaseInfo.status` values).

## Docs
- `docs/api.md`: `/api/v1/auth/check`; full auth flow (server key first, then Firebase ID
  token); new error codes with client actions (`auth_token_expired` → refresh token with
  `getIdToken(true)` and retry once; `auth_unavailable` → laptop has no internet to fetch
  Google certs; `account_not_allowed` → add uid to allowlist).
- `docs/setup.md`: Firebase section — enable the sign-in provider(s) in the console (decided in
  Phase 4), where the service account lives (`secrets/`, git-ignored), non-Docker absolute
  path, deploying rules/indexes, setting `AUTH_ALLOWED_UIDS`.
- `docs/security.md`: token verification, fail-closed init, allowlist, 404-not-403 ownership
  semantics, Admin SDK bypasses rules so server enforces ownership, rules summary, and the
  **Known constraint** paragraph below verbatim in substance.
- README phase table: Phase 2 complete.

### Known constraint (document, do not solve)
Firebase ID tokens expire after 1 hour and can only be refreshed with internet access; the
Admin SDK caches Google's signing certificates in memory only. Without internet, the laptop
can verify tokens only while the phone's current token is valid AND the server has fetched
certs since its last restart. Fully offline events need a separate design decision.

## Done when (architect will verify)
1. `cd server && ./.venv/Scripts/python -m pytest -q -p no:cacheprovider` → all pass, offline.
2. `ruff check .` and `ruff format --check .` clean.
3. With no credentials: server starts, `/health` shows `firebase.status == "not_configured"`,
   `auth.token_verification == "disabled"`, `/api/v1/auth/check` with a valid server key →
   503 `auth_not_configured`.
4. Firestore rules/indexes/firebase.json exist and are valid JSON/rules syntax (no emulator
   needed in sandbox; architect will check).
5. No change to `secrets/`, `android/app/`, root `.env`, `.gitignore`, `.gitattributes`,
   `AGENTS.md`. No real project id, uid, email, or key written anywhere.

## Report back
Files created/modified, exact test + ruff summaries, deviations with reasons.
