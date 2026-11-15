# EventScribe Server

FastAPI foundation for a single laptop inference process. Phase 1 implements health,
protected diagnostics, typed settings, redacting logs, bounded HTTP middleware, local GPU
probing, and operator CLI tools. Model loading and transcription arrive in Phase 3.

See [setup](../docs/setup.md) for Docker/non-Docker installation, all environment fields,
and Private-profile firewall instructions. Run commands from this directory so `.env`
resolves to `server/.env`, never the repository root's file.

```powershell
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m ruff check .
.\.venv\Scripts\python -m ruff format --check .
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

In a second terminal, with the venv activated:

```text
python -m app.cli selftest --base-url http://127.0.0.1:8000 --timeout 5
python -m app.cli qr http://127.0.0.1:8000
python -m app.cli gen-secret
```

`selftest` exits 0 for reachable, schema-valid health even when degraded; failures exit 1.
QR prints exactly the supplied URL and exits 2 if `@`, `?`, or `#` occurs. `gen-secret`
prints a newly generated secret; store it privately. Diagnostics fail closed until a
shared key and a Phase 2 verifier are configured. Tests inject a fake verifier and mocked
GPU/provider/HTTP seams, and prohibit external network access.

Use `create_app(settings)` to inject settings in tests. `TokenVerifier` and `ServerState`
are later-phase seams; no Firebase SDK or inference dependency is installed here.
Keep one Uvicorn worker. Do not run the launchers during automated tests: they deliberately
build containers, create a missing server `.env`, inspect credential filenames, and may
open a browser. Compose's GPU override requests one NVIDIA device; the base file is CPU-safe.
