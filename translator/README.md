# WhisprPersonal local translator

Independent IndicTrans2 FastAPI service on port 8100. Use the existing `translator/.venv`;
do not add dependencies or change the attributed `app/indic_processor.py` port.

Read [the translation guide](../docs/translation.md) for pinned gated-model downloads, private
shared-secret configuration, launch commands, benchmark gating, privacy, and troubleshooting.

```powershell
# From translator/, no model downloads during service startup or tests:
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\run_translator.ps1
```

Public `GET /health` reports configuration boolean and per-direction
`not_downloaded|ready_on_disk|loaded|error`. Authenticated `POST /translate` accepts
`{source_lang,target_lang,segments:[{id,text}]}`. All four languages (`kn,ta,hi,en`) support
cross-language pairs. Errors use `{error:{code,message,request_id}}`. No text appears in logs.

Models and Argos packs stay under `E:/whispr-models`, outside git. No Google service or public
translation endpoint is used. LibreTranslate has its own existing venv and loopback launcher;
its Hindi/English fallback pairs remain disabled until benchmarked and explicitly enabled.
