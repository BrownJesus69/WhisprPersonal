# Server setup

Use Python 3.11+ (the development environment uses 3.12). Docker users need Docker Engine
or Docker Desktop with Compose v2. Windows launchers support Windows PowerShell 5.1;
Linux/macOS launchers need Bash and curl, plus Python 3 or OpenSSL for secret generation.
Windows Docker Desktop must use Linux containers. NVIDIA GPU use additionally requires
a compatible driver and NVIDIA container support; the base Compose file needs no GPU.
No Firebase SDK, Whisper model, or provider connection is required for Phase 1.

## Docker quick start

From `E:\Whispr\server`, double-click `start.bat` or run it from a terminal. On Linux/macOS,
run `bash server/start.sh` from the repository root, or `chmod +x server/start.sh` once and
then `./server/start.sh`. Both launchers change into the server directory.

On first launch only, the script copies `.env.example` to `server/.env`, generates a shared
secret, and prints it once with a private-entry reminder. Keep that value privately; it
is not in the QR code. Existing server `.env` files are never rewritten. If one JSON file
with a safe filename exists in `../secrets/`, the launcher records its container path but
does not open it. Phase 1 only checks file existence. The root `.env` is never used.

The script creates models/data directories, selects the NVIDIA override when supported,
builds and starts the service, polls health for up to 180 seconds, runs selftest, prints LAN
and Tailscale URLs, prints a LAN QR, and opens docs. Windows prefers a DHCP LAN address and
excludes virtual/Tailscale adapters; Linux uses `hostname -I` and macOS uses `en0`. On Linux,
check the printed address if multiple physical/virtual interfaces exist. The QR contains
only a connection URL. Android scanning/recording is unavailable until later phases.

Manual equivalents, after privately creating `server/.env` from the example:

```text
cd server
docker compose -f docker-compose.yml up -d --build
docker compose exec -T server python -m app.cli selftest
docker compose logs --tail 50 server
docker compose down
```

For a GPU add `-f docker-compose.gpu.yml` to every Compose invocation. Validate with
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml config --quiet`.
To validate before a server `.env` exists, add `--no-env-resolution --env-file .env.example`
(the global `--env-file` option belongs before `config`). Avoid printing resolved Compose
configuration in shared logs because it can expose secrets.

The container runs as uid/gid 10001. On Linux, ensure host `models/` and `data/` bind mounts
are writable by that uid before Phase 3. The read-only secret mount must be readable by
the container user when Firebase integration arrives. The Docker image's directory
ownership does not override permissions on host bind mounts.

## Non-Docker development

An existing `server/.venv` is provided on the development machine. For a fresh checkout:

```powershell
cd E:\Whispr\server
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

On Linux/macOS use `python3 -m venv .venv` and `.venv/bin/python` instead. A `.env` is
optional; running from `server/` with no file uses safe defaults. For private LAN access,
bind `--host 0.0.0.0` and configure the firewall. Always use `--no-proxy-headers` for direct
access so the application sees the real socket peer. Set a shared secret yourself via
your environment or a private server `.env` if you need to test auth responses. You can
generate one with `python -m app.cli gen-secret`. Never put credentials into commands or
URLs you share. Real diagnostics remain disabled until Phase 2.

Visit `/health` and `/docs`, then run `python -m app.cli selftest` from the same environment.
Expect HTTP 200, `degraded`, `not_loaded`, `not_started`. This is intentional. GPU probing
is best effort and never blocks core startup on a missing driver/tool. Use
`GPU_DETECTION=off` to disable it. Selftest reports validity and reachability, not model
readiness. API docs can be disabled without affecting health.

## Environment reference

Environment names are case insensitive. `.env` is relative to the current working
directory. Extra names are ignored. Comma lists accept whitespace around entries;
empty lists are written as an empty value. Optional empty values mean unconfigured.
Empty Whisper model values use the Settings defaults. Provider keys without a model
remain `not_configured`; configured providers report `configured_unchecked` without calls.

| Variable | Default | Purpose |
| --- | --- | --- |
| APP_ENV | development | development or production |
| LOG_LEVEL | INFO | Python logging level |
| LOG_FORMAT | json | json or console, both redacted |
| PORT | 8000 | Application configuration; pass Uvicorn `--port` separately for non-Docker |
| ENABLE_API_DOCS | true | Enables /docs, /redoc, /openapi.json |
| SERVER_SHARED_SECRET | empty | SecretStr, at least 32 characters when set |
| FIREBASE_CREDENTIALS_PATH | empty | Local file or `/run/secrets/eventscribe/<file>.json`; only existence checked |
| FIREBASE_PROJECT_ID | empty | Reserved for Phase 2 |
| GROQ_API_KEY | empty | Optional SecretStr |
| GROQ_BASE_URL | https://api.groq.com/openai/v1 | Reserved provider endpoint |
| GROQ_MODEL | empty | Choose a model your account can access; [provider docs](https://console.groq.com/docs) |
| GROQ_TIMEOUT_S | 30 | Positive future provider timeout |
| GROQ_MAX_CONCURRENCY | 2 | Positive future concurrency bound |
| GROQ_MAX_RPM | empty | Optional positive account-specific limit; no quota assumed |
| SAMBANOVA_API_KEY | empty | Optional SecretStr |
| SAMBANOVA_BASE_URL | https://api.sambanova.ai/v1 | Reserved provider endpoint |
| SAMBANOVA_MODEL | empty | Choose a model your account can access; [provider docs](https://docs.sambanova.ai/) |
| SAMBANOVA_TIMEOUT_S | 30 | Positive future provider timeout |
| SAMBANOVA_MAX_CONCURRENCY | 2 | Positive future concurrency bound |
| SAMBANOVA_MAX_RPM | empty | Optional positive account-specific limit; no quota assumed |
| LOCAL_LLM_BASE_URL | empty | Optional local endpoint |
| LOCAL_LLM_MODEL | empty | Both local URL and model required for configured=true |
| WHISPER_MODEL | large-v3-turbo | Planned primary transcription model; empty example uses default |
| WHISPER_FALLBACK_MODEL | large-v3 | Planned fallback; empty example uses default |
| WHISPER_DEVICE | auto | auto, cuda or cpu; preference, not detected device |
| WHISPER_COMPUTE_TYPE | float16 | Planned inference compute type |
| MODELS_DIR | ./models | Docker overrides to /models |
| DATA_DIR | ./data | Docker overrides to /data |
| QUEUE_MAX_DEPTH | 500 | Planned bounded queue capacity |
| WORKER_COUNT | 1 | Planned queue workers; Uvicorn stays single process |
| MAX_CHUNK_UPLOAD_BYTES | 8388608 | Exact session/chunks path ceiling including multipart overhead |
| MAX_JSON_BODY_BYTES | 1048576 | All other HTTP body ceiling |
| RATE_LIMIT_GLOBAL_PER_MINUTE | 1200 | Global token bucket rate and burst |
| RATE_LIMIT_PER_IP_PER_MINUTE | 300 | Per socket peer IP rate and burst |
| RATE_LIMIT_PER_USER_PER_MINUTE | 240 | Verified uid dependency for Phase 2+ |
| ALLOWED_CLIENT_NETWORKS | See below | Comma-separated CIDRs; invalid CIDRs reject startup |
| TRUST_PROXY_HEADERS | false | Explicit X-Forwarded-For trust; requires controlled proxy |
| CORS_ALLOWED_ORIGINS | empty | Comma-separated explicit origins; wildcard rejected |
| GPU_DETECTION | auto | auto or off |
| FEATURE_TRANSLATION | false | Future translation flag |
| FEATURE_CALENDAR | false | Future calendar flag |
| FEATURE_DRIVE | false | Future Drive flag |
| FEATURE_GMAIL | false | Future Gmail flag |
| FEATURE_APP_CHECK | false | No-op until Phase 10 |
| FEATURE_FCM | false | Future notification flag |
| FEATURE_WEB_SEARCH | false | Future web search flag |
| FEATURE_CLOUD_WHISPER | false | Future cloud transcription flag |

Default CIDRs: `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128,fc00::/7,fe80::/10`.
An empty network list denies every peer, including Docker health checks.

`EVENTSCRIBE_BIND` (default `0.0.0.0`) and `EVENTSCRIBE_PORT` (default `8000`) are Compose
host settings, not Settings fields. Shell environment values override Compose `.env` values.
Launchers also read a numeric `EVENTSCRIBE_PORT` from server `.env` if it is absent from the
shell, keeping the polling URL consistent. Docker always listens on container port 8000.
`HF_HOME=/models/hf` is set by the image for later model caching.

## Windows firewall — Private profile only

Confirm that your trusted event LAN uses the Private Windows network profile. From an
Administrator PowerShell, create a narrowly scoped rule (change the port if needed):

```powershell
New-NetFirewallRule -DisplayName 'EventScribe LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private -RemoteAddress LocalSubnet
```

Do not enable it for Public or Domain profiles. Tailscale may need a separately scoped
Private-profile rule for the intended Tailscale peer addresses. Never open a router port
or expose this HTTP endpoint publicly. To remove the rule after use:

```powershell
Remove-NetFirewallRule -DisplayName 'EventScribe LAN'
```

## Verification and troubleshooting

Run the three checks in [server/README.md](../server/README.md) before handoff. Tests use
in-process TestClient with loopback peer addresses and MockTransport, never live external
services. Starlette in the pinned stack emits an httpx deprecation warning; retain the
requested pins instead of installing an additional transport dependency.

If Docker health times out, inspect `docker compose logs --tail 50 server` privately.
Check the server `.env` values without sharing them, bind/port, network allowlist, mount
permissions and Docker status. An invalid secret/CIDR/origin causes configuration failure;
an unset secret permits health but protected routes fail closed. `not_initialized` Firebase,
disabled token verification, and unloaded models are expected Phase 1 states.
