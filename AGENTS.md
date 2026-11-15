# AGENTS.md — EventScribe

Rules for any agent (Claude, Codex, humans) working in this repository.
Repository root: `E:\Whispr` (this is the `eventscribe/` monorepo root).

## Layout

- `server/` — Python 3.11+ (dev machine runs 3.12) FastAPI laptop inference server.
- `android/` — Expo / React Native app (from Phase 4). Firebase Android package name is
  `com.aditya.whisprpersonal` (fixed by `android/app/google-services.json`).
- `docs/` — architecture, api, setup, security, event runbook.
- `plans/` — delegated task specs (kept in git for auditability).
- `secrets/` — local credentials. Git-ignored. **Never read, print, copy, move, or edit.**

## Non-negotiables

1. **Never touch credentials.** Do not open, print, log, copy, rename, or modify anything in
   `secrets/`, `android/app/google-services.json`, or any `.env` file other than creating
   `server/.env.example`. The root `E:\Whispr\.env` is the user's file: leave it alone.
2. **No invented credentials or model names.** Do not hardcode API keys, placeholder keys,
   quotas, or provider model IDs. Unconfigured = feature disabled with a clear
   `not_configured` status, never an error that blocks core transcription.
3. **No secrets in responses, logs, Firestore, QR codes, or the client bundle.** Use
   `pydantic.SecretStr` for secrets; expose only booleans like `configured: true`.
4. **Fail closed** on auth: if the shared secret or token verifier is not configured,
   protected endpoints return 503 with a clear error code, never allow-by-default.
5. **No network calls in tests.** Mock every external service (Firebase, Groq, SambaNova,
   GPU probes).
6. **Never alter raw transcripts** with an LLM unless the user explicitly enables cleanup.
7. Do not run `git commit`, `git push`, or change git config. The architect reviews and commits.
8. Do not modify `.gitignore` or this file.

## Server commands (run from `server/`)

```bash
# Windows (Git Bash)
./.venv/Scripts/python -m pytest -q
./.venv/Scripts/python -m ruff check .
./.venv/Scripts/python -m ruff format --check .
./.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The venv `server/.venv` already exists with dependencies installed. If a new dependency is
needed and the network is blocked, stop and report it instead of working around it.

## Code style

- Python: full type hints, Pydantic v2, async FastAPI endpoints, `ruff` clean
  (line length 100). Small modules, no global mutable state outside `app.state`.
- Heavy CPU/GPU work never runs on the event loop.
- Structured JSON logs with `request_id`, `session_id`, `chunk_id` where relevant.
- Error responses always use the shape
  `{"error": {"code": "<snake_case>", "message": "<safe text>", "request_id": "<id>"}}`
  and never include stack traces, file paths, or secret values.

## Background tasks

Name any background task or agent with an estimated duration, e.g. "Phase 1 build (~15 min)".
