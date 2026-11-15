# Phase 1 — Repository and server foundation

**Working directory:** `E:\Whispr` (monorepo root). Server code lives in `E:\Whispr\server`.
**Read `E:\Whispr\AGENTS.md` first and obey every non-negotiable in it.**

## Goal

Create the EventScribe monorepo skeleton and a production-quality FastAPI server foundation
(config, structured logging, error taxonomy, security middleware skeleton, `/health`,
Docker Compose, launchers, tests) that later phases plug Firebase, Whisper, and LLMs into.

## Out of scope for this phase (do NOT implement)

Firebase Admin init/token verification (Phase 2), faster-whisper/VAD/queue worker (Phase 3),
any Android code (Phase 4+), Groq/SambaNova HTTP calls (Phase 8). Leave clean seams for them.

## Scope — files to create

```
README.md                      # root: overview, ASCII architecture diagram, quick start,
                               # phase status table, security model summary, limitations
docs/architecture.md           # component diagram + data flow (planned), Phase-1 reality
docs/api.md                    # auth headers, error format + code table, /health and
                               # /api/v1/diagnostics fully documented, other endpoints listed
                               # as "planned (Phase N)"
docs/setup.md                  # prerequisites, Docker + non-Docker server setup, .env
                               # reference table, Windows firewall (Private profile only)
docs/security.md               # initial threat model, secrets handling, fail-closed auth,
                               # LAN-only network filter, what is not yet implemented
docs/event-runbook.md          # skeleton headings only, marked "completed in Phase 9"
android/README.md              # placeholder: app arrives in Phase 4; package name
                               # com.aditya.whisprpersonal; google-services.json is
                               # git-ignored and must never be committed
server/pyproject.toml          # project metadata, ruff (line-length 100, py311 target,
                               # rules E,F,I,B,UP,S,ASYNC with tests allowing S101),
                               # pytest (testpaths = ["app/tests"])
server/requirements.txt        # runtime deps pinned with == (versions below)
server/requirements-dev.txt    # -r requirements.txt + pytest, ruff
server/.env.example
server/Dockerfile
server/docker-compose.yml
server/docker-compose.gpu.yml
server/.dockerignore
server/start.bat
server/start.sh
server/scripts/start.ps1
server/README.md
server/app/__init__.py         # __version__ = "0.1.0"
server/app/main.py
server/app/config.py
server/app/cli.py
server/app/core/__init__.py
server/app/core/logging.py
server/app/core/errors.py
server/app/core/request_context.py
server/app/security/__init__.py
server/app/security/shared_secret.py
server/app/security/auth.py
server/app/security/rate_limit.py
server/app/security/body_limit.py
server/app/security/network.py
server/app/security/headers.py
server/app/schemas/__init__.py
server/app/schemas/common.py   # ErrorBody / ErrorResponse
server/app/schemas/health.py
server/app/services/__init__.py
server/app/services/gpu.py
server/app/services/state.py
server/app/routers/__init__.py
server/app/routers/health.py
server/app/routers/diagnostics.py
server/app/models/__init__.py  # docstring only: domain models arrive in Phase 2/3
server/app/workers/__init__.py # docstring only: transcription worker arrives in Phase 3
server/app/tests/__init__.py
server/app/tests/conftest.py
server/app/tests/test_*.py     # see Tests section
```

Pinned runtime versions (already installed in `server/.venv` — use exactly these):
`fastapi==0.163.0`, `uvicorn[standard]==0.54.0`, `pydantic==2.14.3`,
`pydantic-settings==2.16.3`, `httpx==0.28.1`, `python-multipart==0.0.33`, `qrcode==8.2`.
Dev: `pytest==9.2.0`, `ruff==0.17.5`. Do not add other dependencies.

## Design (follow precisely)

### config.py
- `class Settings(BaseSettings)` with `model_config = SettingsConfigDict(env_file=".env",
  env_file_encoding="utf-8", extra="ignore", case_sensitive=False)`.
- `get_settings()` cached with `functools.lru_cache`. `create_app(settings: Settings | None)`
  must accept an explicit Settings for tests.
- Fields (env var = upper-case field name), defaults in brackets:
  - `app_env` Literal["development","production"] [development]; `log_level` [INFO];
    `log_format` Literal["json","console"] [json]; `port` int [8000];
    `enable_api_docs` bool [True]
  - `server_shared_secret: SecretStr | None` [None]; validator: if set, min 32 chars.
  - `firebase_credentials_path: Path | None` [None]; `firebase_project_id: str | None` [None]
  - Groq: `groq_api_key: SecretStr|None`, `groq_base_url` ["https://api.groq.com/openai/v1"],
    `groq_model: str|None` [None — no default model; user must choose],
    `groq_timeout_s` float [30], `groq_max_concurrency` int [2], `groq_max_rpm: int|None` [None]
  - SambaNova: same shape, `sambanova_base_url` ["https://api.sambanova.ai/v1"], model None.
  - Local LLM (optional): `local_llm_base_url: str|None`, `local_llm_model: str|None`.
  - Whisper: `whisper_model` ["large-v3-turbo"], `whisper_fallback_model` ["large-v3"],
    `whisper_device` Literal["auto","cuda","cpu"] [auto], `whisper_compute_type` [float16],
    `models_dir: Path` [./models], `data_dir: Path` [./data]
  - Queue: `queue_max_depth` int [500], `worker_count` int [1]
  - Limits: `max_chunk_upload_bytes` [8_388_608], `max_json_body_bytes` [1_048_576],
    `rate_limit_global_per_minute` [1200], `rate_limit_per_ip_per_minute` [300],
    `rate_limit_per_user_per_minute` [240]
  - Network: `allowed_client_networks: list[str]` default
    `["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","100.64.0.0/10",
    "::1/128","fc00::/7","fe80::/10"]` (100.64/10 = Tailscale CGNAT);
    `trust_proxy_headers` bool [False]
  - `cors_allowed_origins: list[str]` [[]]; validator rejects "*".
  - `gpu_detection` Literal["auto","off"] [auto]
  - Feature flags, all bool default False: `feature_translation`, `feature_calendar`,
    `feature_drive`, `feature_gmail`, `feature_app_check`, `feature_fcm`,
    `feature_web_search`, `feature_cloud_whisper`.
- List fields must accept comma-separated env values (`A,B,C`): use
  `Annotated[list[str], NoDecode]` + a `field_validator(mode="before")` that splits strings.
  Validate each network with `ipaddress.ip_network(strict=False)`.
- Properties: `groq_configured` = key set AND model set; same for sambanova; `local_llm_configured`;
  `firebase_credentials_present` = path set AND file exists (never read it in Phase 1).
- `safe_summary() -> dict` for diagnostics: every secret/path replaced by a boolean
  (`"server_shared_secret_set": True`). Never return file paths (they leak usernames).

### core/logging.py
- `configure_logging(settings)`: root logger, one stdout handler, JSON formatter (one JSON
  object per line: `ts` ISO-8601 UTC, `level`, `logger`, `msg`, plus `request_id`,
  `session_id`, `chunk_id` from contextvars when set, plus any `extra={"event": ..., ...}`
  keys). `console` format = human readable, same fields.
- `RedactingFilter` applied to the handler: scrubs `Bearer <token>` → `Bearer [REDACTED]`,
  values of the `X-EventScribe-Server-Key` header, `-----BEGIN ... PRIVATE KEY-----` blocks,
  and long secret-like strings with known prefixes (`gsk_`, `sk-`, `AIza`). Also scrubs any
  secret value from the active Settings (register them at configure time) wherever it appears.
- Exceptions: include `exc_type` and a traceback in logs (server-side only), never in responses.
- Contextvars `request_id_var`, `session_id_var`, `chunk_id_var` live in
  `core/request_context.py`.

### core/errors.py
- `class ErrorCode(StrEnum)` including at least: `bad_request`, `validation_error`,
  `not_found`, `method_not_allowed`, `missing_server_key`, `invalid_server_key`,
  `server_not_configured`, `missing_auth_token`, `invalid_auth_token`, `auth_not_configured`,
  `forbidden`, `network_not_allowed`, `payload_too_large`, `rate_limited`,
  `feature_disabled`, `provider_unavailable`, `queue_full`, `model_not_ready`,
  `internal_error`. Map each to an HTTP status in one dict.
- `class AppError(Exception)` with `code`, `message` (safe, user-facing), `status_code`
  (derived from code unless overridden), optional `details: dict` (safe), optional
  `headers` (e.g. Retry-After).
- `register_exception_handlers(app)`: AppError, `RequestValidationError` (422
  `validation_error`, details = list of `{loc, msg, type}` WITHOUT the `input` value),
  Starlette `HTTPException` (map 404/405/others), and bare `Exception` → 500
  `internal_error` with message "An unexpected error occurred." All bodies use
  `ErrorResponse` and include `request_id`. Log the unhandled exception with traceback.

### core/request_context.py
- Pure-ASGI middleware (not BaseHTTPMiddleware) that: takes client `X-Request-ID` if it
  matches `^[A-Za-z0-9-]{8,64}$` else generates `uuid4().hex`; sets `request_id_var`;
  adds `X-Request-ID` to the response; logs one access line
  (`event="http_request"`, method, path, status, duration_ms, client_ip) — never headers or
  bodies. Also handles `websocket` scope (sets request id, no response header).

### security/
- `network.py`: pure-ASGI middleware. Client IP = `scope["client"][0]` (ignore
  X-Forwarded-For unless `trust_proxy_headers`). If the IP is unparsable or not in
  `allowed_client_networks` → 403 `network_not_allowed` (HTTP) / close code 1008 (WebSocket).
  Fail closed.
- `body_limit.py`: pure-ASGI middleware. Limit = `max_chunk_upload_bytes` for paths matching
  `^/api/v1/sessions/[^/]+/chunks$`, else `max_json_body_bytes`. Reject early on
  `Content-Length` > limit with 413 `payload_too_large`; also wrap `receive` and count streamed
  bytes so chunked bodies without Content-Length are cut off (return 413 if the app has not
  started a response yet).
- `rate_limit.py`: `TokenBucketLimiter(rate_per_minute, burst=None, max_keys=10_000)` using
  `time.monotonic`, `check(key) -> RateDecision(allowed: bool, retry_after_s: float)`,
  bounded memory (evict least-recently-seen keys). Clock injectable for tests. A pure-ASGI
  middleware enforces the global + per-IP limits; `per_user_rate_limit` is a FastAPI
  dependency (keyed by verified uid) for Phase 2+. 429 `rate_limited` with an integer
  `Retry-After` header (ceil, min 1). `/health` is limited too.
- `shared_secret.py`: FastAPI dependency `require_server_key`. Header
  `X-EventScribe-Server-Key`. Secret unset → 503 `server_not_configured`; header missing →
  401 `missing_server_key`; mismatch → 401 `invalid_server_key`. Compare with
  `hmac.compare_digest` on UTF-8 bytes.
- `auth.py`:
  - `@dataclass(frozen=True) class VerifiedUser: uid: str; email: str | None; claims: Mapping`
  - `class TokenVerifier(Protocol): async def verify(self, id_token: str) -> VerifiedUser`
    (raises `AppError(invalid_auth_token)` on bad tokens).
  - `DisabledTokenVerifier` — raises `AppError(auth_not_configured)` (503). This is the
    Phase-1 default on `app.state.token_verifier`; Phase 2 swaps in Firebase.
  - Dependency `get_current_user`: parse `Authorization: Bearer <token>` (case-insensitive
    scheme, reject empty) → 401 `missing_auth_token`; else `await
    request.app.state.token_verifier.verify(token)`.
  - Dependency `require_auth` = `require_server_key` THEN `get_current_user` (shared secret is
    checked first so unauthenticated LAN noise never reaches Firebase). Returns VerifiedUser.
  - Docstring placeholder for App Check (`feature_app_check`, Phase 10): when enabled and not
    implemented, do nothing (must not block MVP).
- `headers.py`: pure-ASGI middleware adding `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on `/api/` and `/health`.
- CORS: only add `CORSMiddleware` when `cors_allowed_origins` is non-empty
  (allow_credentials=False, explicit methods/headers).

Middleware order (outermost first): request_context → network filter → security headers →
body limit → rate limit → (CORS if configured) → app.

### services/
- `gpu.py`: `async def detect_gpu(settings) -> GpuInfo` (`available: bool | None`,
  `name: str|None`, `vram_total_mb: int|None`, `detection: Literal["ctranslate2",
  "nvidia-smi","disabled","unavailable"]`). If `gpu_detection == "off"` → disabled.
  Try `import ctranslate2; ctranslate2.get_cuda_device_count()` (ImportError tolerated —
  it is not installed in Phase 1), then `nvidia-smi
  --query-gpu=name,memory.total --format=csv,noheader,nounits` via
  `asyncio.create_subprocess_exec` with a 3 s timeout (FileNotFoundError tolerated). Run once
  at startup in lifespan; store result in state. Never crash startup.
- `state.py`: `ServerState` dataclass on `app.state.server_state`: `started_at`,
  `gpu: GpuInfo`, `model_status: Literal["not_loaded","loading","ready","error"]`
  ["not_loaded"], `model_name`, `queue_depth` [0], `queue_status:
  Literal["not_started","running","stopping"]` ["not_started"]. Phase 3 will mutate these.

### routers/
- `health.py`: `GET /health` — public (no auth), still behind network filter & rate limit.
  Response model `HealthResponse`:
  ```
  status: "ok" | "degraded"          # degraded if model not ready or queue not running
  version, server_time (UTC ISO), uptime_s
  model: {name, fallback_name, status, device}      # device = settings.whisper_device
  gpu: {available, name, vram_total_mb, detection}
  queue: {status, depth, max_depth, workers}
  providers: {groq: P, sambanova: P, local_llm: P}  # P = {configured: bool,
             #   status: "not_configured" | "configured_unchecked"}  (no network calls)
  firebase: {credentials_present: bool, status: "not_initialized"}
  auth: {shared_secret_configured: bool, token_verification: "disabled"}
  features: {translation: bool, calendar: ..., cloud_whisper: ...}
  ```
  Must never contain secret values or filesystem paths.
- `diagnostics.py`: `GET /api/v1/diagnostics`, `dependencies=[Depends(require_auth)]`.
  Returns health payload + `python_version`, `platform`, `config: settings.safe_summary()`,
  `limits` (body/rate limits). (In Phase 1 it returns 503 `auth_not_configured` in real use,
  because the verifier is disabled — that is correct and expected.)

### main.py
- `create_app(settings: Settings | None = None) -> FastAPI` and module-level
  `app = create_app()`. Lifespan: configure logging, log a startup line with
  `settings.safe_summary()`, detect GPU, set `app.state.settings`, `server_state`,
  `token_verifier = DisabledTokenVerifier()`, rate limiters; on shutdown log
  `event="shutdown"` (Phase 3 will drain the queue here). `docs_url`/`openapi_url` disabled
  when `enable_api_docs` is False. Title "EventScribe Server", version from `app.__version__`.
- Creating the app must not require a `.env` file to exist and must not touch the network.

### cli.py (`python -m app.cli <command>`, argparse)
- `qr <url>` — print the URL and an ASCII QR code (`qrcode.QRCode().print_ascii(invert=True)`)
  of exactly that URL. Refuse URLs containing `@`, `?`, or `#` (no credentials or query data in
  QR codes — print an error, exit 2).
- `selftest [--base-url http://127.0.0.1:8000] [--timeout 5]` — GET `/health` with httpx,
  validate it parses as `HealthResponse`, print a short PASS/FAIL report (model status, GPU,
  queue, providers configured y/n), exit 0 on reachable+valid, 1 otherwise. Must accept an
  injectable `httpx` transport for tests.
- `gen-secret` — print `secrets.token_urlsafe(48)`.

### Docker
- `Dockerfile`: `FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04` (tag verified to exist;
  CUDA 12 + cuDNN 9 is what faster-whisper/CTranslate2 4.x need in Phase 3). Install
  `python3 python3-venv python3-pip ca-certificates` (Ubuntu 24.04 ships Python 3.12) with
  `--no-install-recommends`, clean apt lists. Venv at `/opt/venv`. Non-root user
  `eventscribe` (uid/gid 10001). `ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
  MODELS_DIR=/models DATA_DIR=/data HF_HOME=/models/hf`. Copy requirements first (layer
  cache), then `app/`. `/models` and `/data` owned by the user. `EXPOSE 8000`.
  `HEALTHCHECK` using python urllib against `http://127.0.0.1:8000/health`.
  `CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--workers","1",
  "--no-server-header"]` (single worker: the Whisper model lives in one process).
- `docker-compose.yml` (CPU-safe base; works on macOS/Kali/Windows without NVIDIA):
  service `server`, `build: .`, `image: eventscribe-server:local`, `env_file: .env`,
  `environment: MODELS_DIR=/models, DATA_DIR=/data`,
  `ports: ["${EVENTSCRIBE_BIND:-0.0.0.0}:${EVENTSCRIBE_PORT:-8000}:8000"]`,
  volumes `./models:/models`, `./data:/data`, `../secrets:/run/secrets/eventscribe:ro`,
  `restart: unless-stopped`, `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`,
  `stop_grace_period: 30s`, logging json-file with max-size 10m / max-file 5.
- `docker-compose.gpu.yml`: override adding
  `deploy.resources.reservations.devices: [{driver: nvidia, count: 1, capabilities: [gpu]}]`.
- `.dockerignore`: `.venv`, `models`, `data`, `.env`, `__pycache__`, tests caches, etc.

### .env.example
Every Settings field, grouped with comments. Secrets and model names EMPTY. Include:
`FIREBASE_CREDENTIALS_PATH=` with a comment that the launcher fills it with
`/run/secrets/eventscribe/<file>.json` when exactly one JSON file exists in `../secrets/`;
`SERVER_SHARED_SECRET=` (launcher generates it); `GROQ_MODEL=` / `SAMBANOVA_MODEL=` with a
comment "choose a model your account can access; see provider docs — no default is assumed".
No real-looking placeholder keys.

### Launchers
- `start.bat`: tiny wrapper: `powershell -NoProfile -ExecutionPolicy Bypass -File
  "%~dp0scripts\start.ps1" %*` then `pause` so double-click users see output.
- `scripts/start.ps1` (must run on Windows PowerShell 5.1 — no `&&`, `??`, ternary):
  1. `Set-Location` to the server dir. Check `docker info` succeeds, else print
     "Docker Desktop is not running. Start it and re-run start.bat." and exit 1.
  2. If `.env` missing: copy `.env.example`; generate a shared secret with
     `[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes(...)` →
     base64url (48 bytes); set `SERVER_SHARED_SECRET=`; if exactly one `*.json` in
     `..\secrets\`, set `FIREBASE_CREDENTIALS_PATH=/run/secrets/eventscribe/<name>`.
     **Write with `[IO.File]::WriteAllText($path, $text, (New-Object
     System.Text.UTF8Encoding $false))` — no BOM.** Never print the secret except once with a
     clear "enter this in the app's Settings; it is NOT in the QR code" message.
     If `.env` exists, never modify it.
  3. Ensure `models\` and `data\` exist.
  4. Compose files: base + `docker-compose.gpu.yml` if `nvidia-smi` is on PATH and succeeds.
  5. `docker compose <files> up -d --build`.
  6. Poll `http://127.0.0.1:<port>/health` (Invoke-WebRequest -UseBasicParsing) every 2 s up
     to 180 s; on timeout print `docker compose logs --tail 50 server` and exit 1.
  7. Self-test: `docker compose <files> exec -T server python -m app.cli selftest`.
  8. LAN IPv4: `Get-NetIPAddress -AddressFamily IPv4` excluding 127.*, 169.254.*, and
     interface aliases matching `vEthernet|WSL|Docker|Loopback|Tailscale`; prefer
     PrefixOrigin Dhcp. Tailscale: `tailscale ip -4` if the command exists.
     Print each URL `http://<ip>:<port>`; print QR for the LAN URL via
     `docker compose exec -T server python -m app.cli qr <url>`.
  9. Print model/queue status (from health JSON) and a note that model loading arrives in
     Phase 3. Open `http://localhost:<port>/docs` with `Start-Process`.
  Port comes from `EVENTSCRIBE_PORT` env or 8000.
- `start.sh` (bash, `set -euo pipefail`, Linux + macOS): same steps. Secret via
  `python3 -c 'import secrets;print(secrets.token_urlsafe(48))'` or `openssl rand -base64 48 |
  tr '+/' '-_' | tr -d '='`. `sed -i.bak` portable edits (delete .bak). GPU override only if
  `nvidia-smi` works AND `docker info` mentions the nvidia runtime. LAN IP: `hostname -I`
  (Linux) or `ipconfig getifaddr en0` (macOS). Open docs with `xdg-open`/`open` if present.
  Must be executable-ready (LF line endings). `start.bat`/`start.ps1` use CRLF.

## Tests (`server/app/tests/`, pytest, FastAPI `TestClient`)

`conftest.py`: `make_settings(**overrides)` building `Settings(_env_file=None, ...)` with
tmp `models_dir`/`data_dir`, `gpu_detection="off"`, a 48-char shared secret, no provider keys.
`client` fixture uses `TestClient(app, client=("127.0.0.1", 50000))` (TestClient's default
host "testclient" is not an IP and must be rejected by the network filter).
`FakeTokenVerifier` accepting token `"good-token"` → uid `"user-1"`, else `invalid_auth_token`.

Required tests (one file per area):
- `test_health.py`: 200 + schema; `status == "degraded"` with model not_loaded; providers
  `not_configured` without keys; `configured_unchecked` with key+model; key without model →
  not_configured; response body contains neither the shared secret, nor a fake provider key,
  nor `tmp_path` strings; security headers present.
- `test_errors.py`: unknown path → 404 `not_found` with `request_id`; validation error shape
  has no `input`; a test-only route raising `RuntimeError("secret-ish detail")` → 500
  `internal_error`, body lacks "Traceback" and "secret-ish detail" (use
  `TestClient(..., raise_server_exceptions=False)`).
- `test_request_id.py`: valid client id echoed; invalid (`"bad id!"`) replaced with a new one.
- `test_shared_secret.py`: diagnostics with missing key → 401 `missing_server_key`; wrong →
  401 `invalid_server_key`; secret unset in settings → 503 `server_not_configured`; correct key
  + good token (fake verifier) → 200 and body has no secret values.
- `test_auth.py`: missing/malformed Bearer → 401 `missing_auth_token`; default
  DisabledTokenVerifier → 503 `auth_not_configured`; fake verifier bad token → 401
  `invalid_auth_token`.
- `test_network.py`: client `("8.8.8.8", 1)` → 403 `network_not_allowed`; `("100.101.1.2",1)`
  (Tailscale) → 200; `("testclient", 1)` → 403.
- `test_body_limit.py`: Content-Length over JSON limit → 413 `payload_too_large`; chunk path
  uses the larger limit (a body between the two limits is not rejected by the middleware — use a
  test-only POST route at `/api/v1/sessions/abc/chunks`).
- `test_rate_limit.py`: unit-test TokenBucketLimiter with a fake clock (allow, deny, refill,
  key eviction bound); integration: per-IP limit 2/min → third request 429 with integer
  `Retry-After`.
- `test_config.py`: short secret rejected; `CORS_ALLOWED_ORIGINS="*"` rejected; comma list
  parsing for networks/origins; invalid CIDR rejected; `safe_summary()` and `repr(settings)`
  contain no secret values or paths.
- `test_logging.py`: JSON line includes `request_id` when set; RedactingFilter scrubs a Bearer
  token, a `gsk_...` string, a PEM private-key block, and the configured shared secret.
- `test_gpu.py`: `gpu_detection="off"` → `detection == "disabled"`; nvidia-smi missing
  (monkeypatch subprocess to raise FileNotFoundError) → `available is False`/None without
  raising.
- `test_cli.py`: `qr` prints the URL and refuses `http://u:p@host` and `?x=1`;
  `selftest` PASS via `httpx.MockTransport` returning a valid health JSON, FAIL (exit 1) on
  connection error / invalid JSON.

## Done when (architect will verify each)

1. `cd server && ./.venv/Scripts/python -m pytest -q` → all tests pass, zero network access.
2. `./.venv/Scripts/python -m ruff check .` and `ruff format --check .` → clean.
3. `./.venv/Scripts/python -m uvicorn app.main:app --port 8000` starts with no `.env`;
   `GET /health` → 200 JSON with `model.status == "not_loaded"`, `status == "degraded"`;
   `GET /api/v1/diagnostics` without headers → 401 `missing_server_key` (secret unset → 503
   `server_not_configured`).
4. `docker compose -f docker-compose.yml -f docker-compose.gpu.yml config` parses (daemon not
   required for `config`).
5. Nothing in `secrets/`, `android/app/`, root `.env`, `.gitignore`, or `AGENTS.md` changed.
6. No secret values, provider model IDs, or quota numbers are hardcoded anywhere except the
   documented base URLs and the generic rate-limit defaults above.

## Report back

List files created, the exact test/ruff output summary, and anything you could not do
(e.g., blocked network) or deviated from — with the reason.
