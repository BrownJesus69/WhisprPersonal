# WhisprPersonal Server

FastAPI foundation for a single laptop inference process. Phase 1 implements health,
protected diagnostics, typed settings, redacting logs, bounded HTTP middleware, local GPU
probing, and operator CLI tools. Phase 2 adds Firebase identity; Phase 3 implements
Whisper/VAD, SQLite chunk persistence, language tracking, resumable streams and final cloud sync.

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
shared key and a Firebase verifier are configured. Tests inject a fake verifier and mocked
GPU/provider/HTTP seams, and prohibit external network access.

Use `create_app(settings)` to inject settings in tests. `TokenVerifier` and `ServerState`
are injection seams. Firebase and Whisper dependencies are pinned; real services/models
are replaced with offline fakes in normal tests.

Optional local AI4Bharat IndicConformer (MIT) handles Kannada (`kn`), Hindi (`hi`), and
Tamil (`ta`) on CPU. English and language detection remain on Whisper; auto mode's
resolved language selects the engine. Indic returns RNNT text and CTC word times for
overlap stitching, with character-proportional timing when word counts differ. Personal
words do not apply to Indic-routed chunks. Any Indic load/run failure falls back to Whisper.

Settings: `INDIC_ASR_ENABLED=true`, `INDIC_ASR_LANGUAGES=kn,hi,ta` (validated against
`SUPPORTED_LANGUAGES`; defaults intersect the supported list), and `INDIC_ASR_MODEL_DIR`
(relative to `MODELS_DIR`, or absolute). The default directory is
`models--ai4bharat--indic-conformer-600m-multilingual/snapshots/2a77d305038dfc502fd9464e7d028b90381976cb`.
Weights load lazily and stay resident; no downloads occur. `/health.indic_asr` reports
`not_configured`, `not_loaded`, `ready`, or `error`, enabled languages and model name,
without paths. The Docker image does not include torch or the Indic weights; Whisper
continues to work when the optional dependencies/files are unavailable.

Manual recording checks (prints transcript text, never part of pytest), from `server/`:

```powershell
./.venv/Scripts/python scripts/indic_asr_check.py ses_fcfd170078984cedb8bb2071 kn
./.venv/Scripts/python scripts/indic_asr_check.py ses_c19c3dcf89af41a28586af32 hi
```

The script ignores environment files, uses locally cached models only, and processes every
WAV below `data/audio/<session>/`, printing per-chunk elapsed time (including cold loading
on first use) and text. It uses the composite engine, including Whisper fallback.
Keep one Uvicorn worker. Do not run the launchers during automated tests: they deliberately
build containers, create a missing server `.env`, inspect credential filenames, and may
open a browser. Compose's GPU override requests one NVIDIA device; the base file is CPU-safe.

Pre-download models with `python -m app.cli download-models [--fallback]`, then set
`WHISPER_LOCAL_FILES_ONLY=true`. Default preload loads turbo asynchronously; disable with
`WHISPER_PRELOAD=false` for a liveness-only server. The GPU test is opt-in via
`WHISPR_RUN_GPU_TESTS=1` and uses only the existing local model cache.
