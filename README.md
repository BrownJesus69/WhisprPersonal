# WhisprPersonal

WhisprPersonal is a planned Android event transcription app backed by a laptop inference
server. Phase 1 provides the FastAPI foundation, local status checks, security boundaries,
operator tools, and deployment scaffolding. Phase 2 adds Firebase authentication and ownership
helpers. Phase 3 adds durable chunked Whisper transcription, resumable streams, and final Firestore sync.

```text
Android app (Phase 4+) -- LAN / Tailscale --> Laptop FastAPI server
                                             |-- /health + protected diagnostics (Phase 1)
                                             |-- Firebase identity (Phase 2)
                                             |-- queue -> Whisper GPU/CPU (Phase 3)
                                             `-- optional LLM providers (Phase 8)
```

For a first local check, use the existing Python environment from the server directory:

```powershell
cd E:\Whispr\server
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Open <http://127.0.0.1:8000/health>. No `.env` is required. A running server
with `WHISPER_PRELOAD=false` returns HTTP 200 with `status: degraded`, `model.status: not_loaded`, and
`queue.status: running`. In another terminal, run
`python -m app.cli selftest` with the same environment. PASS means reachable and valid;
it does not mean transcription is ready.

For Docker, run `server/start.bat` on Windows or `bash server/start.sh` on Linux/macOS.
The launcher creates only a missing `server/.env`, generates a private server key, builds
the container, checks health, and prints a connection URL and QR. The key is entered
separately in the future app's Settings. See [setup](docs/setup.md) before LAN use.

| Phase | Status / scope |
| --- | --- |
| 1 | Implemented: repository and server foundation |
| 2 | Complete: Firebase identity, ownership helpers, Firestore rules and indexes |
| 3 | Implemented: Whisper/VAD, SQLite queue, language tracking, resumable WebSocket, final Firestore sync |
| 4–7 | Planned: Android app and event workflows |
| 8 | Planned: optional Groq/SambaNova integrations |
| 9 | Planned: event operations runbook |
| 10 | Planned: App Check and further integration hardening |

The server allowlists private, loopback, link-local IPv6 and Tailscale CGNAT networks.
Protected APIs check a shared key before verifying identity. Unconfigured Firebase verification
fails closed. Health is public within allowed networks and remains rate limited. Secret
values and credential paths are excluded from health and diagnostics; logs are redacted.
Raw transcripts will remain unchanged unless cleanup is explicitly enabled.

HTTP is not encrypted: use a trusted LAN or Tailscale, avoid Internet exposure, and keep
the firewall limited to the Private profile. Persistent rate limits and remote provider checks are not available yet. Run one server worker; limits and state are process
local. Future integration flags report intent only.

Read [architecture](docs/architecture.md), [API](docs/api.md), [security](docs/security.md),
and the [server development guide](server/README.md). Follow [AGENTS.md](AGENTS.md) when
contributing; credentials, root `.env`, `.gitignore`, and `AGENTS.md` are protected.
