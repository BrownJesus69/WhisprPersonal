# Phase 10b — App translation UI + disabled future integrations

**Working directory:** `E:\Whispr`. Read `E:\Whispr\AGENTS.md` (wins) and `android/AGENTS.md`.
**No network**, no new dependencies. Phases 1–10a are committed. Never write temp output into
`E:\Whispr\output\` (use your own temp dir; pytest `--basetemp` outside the repo). Do not touch
`secrets/`, `android/app/google-services.json`, any `.env` (only `.env.example`), `.gitignore`,
`AGENTS.md`, or `translator/` (10a, verified on real models — leave it). Do not run `git commit`.
Commands: server `./.venv/Scripts/python -m pytest -q -p no:cacheprovider --basetemp=<temp>`,
`ruff check .`, `ruff format --check .`; app `npx tsc --noEmit`, `npx eslint .`, `npx jest`.

## Server contract (implemented in 10a — source of truth, do not change behaviour)
`server/app/routers/translation.py`, `server/app/services/translation/*`, `docs/translation.md`,
`docs/api.md`:
- `POST /api/v1/translate {event_id, session_ids[1..20], target_lang: kn|ta|hi|en, polish=false}`
  → 202 `{job_id, status}`; 409 `transcript_incomplete` if a session is not finalized; 503
  `translation_unavailable` ("Translation unavailable; showing the original transcript.").
- `GET /api/v1/translation/jobs/{job_id}` → `{job_id, status, error_code, result}`
  (queued|running|done|failed|interrupted).
- `GET /api/v1/sessions/{id}/translations?target_lang=` → `{session_id, target_lang, chunks:
  [{sequence, source_lang, text, engine, model, created_at, polished_text, polish_provider,
  polish_model, polished_at, error_code}]}`. `engine` ∈ `indictrans2 | libretranslate |
  groq-audio-translation`; `source_lang` may be `und` for the audio fallback.
- `GET /api/v1/translation/status` → engines status (read the code for the exact shape).
- Stream event `chunk_audio_translated {seq, session_id, ts, data: {sequence, target_lang, engine}}`
  (read `server/app/schemas/stream.py`) — the phone must accept it (validator) and, on receipt,
  fetch the session's English translations; unknown event types must never break the stream.

## A. App — translation (`android/src/lib/translation/`)
- `api.ts` typed wrappers with runtime validation; reuse `authedClient` and the job-poller
  pattern from `lib/ai/jobs.ts` (persist job ids so polling resumes after restart; new local
  kind `translate` — extend the local `ai_jobs.kind` handling or add a `translation_jobs`
  table; SQLite migration 6).
- Local table `translations(session_id, sequence, target_lang, source_lang, text, engine,
  model, created_at, polished_text, polish_provider, polish_model, polished_at, error_code,
  PRIMARY KEY(session_id, sequence, target_lang))`; stored separately; **never** written into
  `transcript_chunks`; deleting a session deletes them (extend `deleteSessionRows`).
- **Transcript viewer + session screen (finalized sessions only)**: a "Translate" control
  (target picker English/Kannada/Tamil/Hindi; the source language comes from each chunk) and an
  optional "AI-polish the translation" toggle shown only when `/ai/status` has a usable provider
  for the event's privacy mode (cloud only for `cloud_ai` events). A **Translation** tab next to
  Raw/Polished: each row shows the translated text with a label line
  `IndicTrans2 · indictrans2-indic-en-1B@ac3daf0 · kn→en · 16 Nov 2026, 10:32` (engine, model,
  source, target, timestamp — **every** translation is labelled); when `polished_text` exists
  show it in a separate, clearly marked block "AI-polished (Groq · <model>)" under the dedicated
  translation, never replacing it; `source_lang 'und'` + `groq-audio-translation` rows are
  labelled "Emergency English translation from audio (Groq) — no transcript was produced";
  missing/failed rows show the original text with a muted "Not translated" note. The original
  transcript stays one tap away (Raw tab) and is never altered.
- Unavailable/failed → a **non-blocking** banner "Translation unavailable; showing the original
  transcript." and the Raw tab remains usable. No translation during live recording (control
  hidden until the session is finalized).
- Export (`lib/export/compose.ts` + export screen): optional "Include translation (target)"
  section after the transcript, every line labelled as above; default off.
- Diagnostics: add translation status (engines, directions on disk/loaded, LibreTranslate
  enabled pairs) from `/api/v1/translation/status` — whitelisted words only.

## B. Disabled future integrations (server + app + docs)
Owner's spec: "For each future integration, create a feature flag, provider interface,
configuration placeholder, and disabled-by-default UI state. Do not call an unconfigured API or
show an error that blocks the core app." Google Cloud Translation is **removed** from the list
(replaced by the local translator — do not add any Google translation code or key).
- Server `app/integrations/` — one module per integration with a `Protocol` interface and a
  `Disabled*` implementation that performs **no network calls** and reports
  `{enabled: false, status: "not_configured" | "disabled", docs: "docs/integrations.md#<anchor>"}`:
  **Calendar** (create/list event stubs), **Drive** (export upload stub), **Gmail** (send brief
  stub), **App Check** (token verifier stub: when `feature_app_check` is true but not
  configured → status `not_configured` and **never enforced**; enforcement exists only behind
  both the flag and a configured verifier, default off, must not block the MVP), **FCM** (push
  stub), **Web search enrichment** (stub), **Cloud Whisper** (text: "not configured; emergency
  English-only audio translation via Groq is available separately when enabled"). Use the
  existing `feature_*` flags in `config.py`; remove/repurpose `feature_translation` so it no
  longer suggests Google — translation status now comes from the translator. Config
  placeholders only (empty, `None`), no invented credentials, scopes, model names or quotas.
  `/health` and `/api/v1/diagnostics` gain an `integrations` block (static, no I/O).
  Tests: every stub makes no network call (assert with a MockTransport that fails on any
  request), flags default false, App Check never blocks a request unless enabled + configured,
  health shape.
- App: replace `src/features/integrations.ts` with statuses from the server health when
  connected (fallback to the static "Not configured" list offline). Settings → "Future
  integrations" shows each as disabled with a one-line explanation; **Translation** moves out of
  this list into its own "Translation (on your laptop)" row showing live engine status.
- `docs/integrations.md` (new): for each integration — what it would do, the feature flag, the
  config placeholders, what the owner must provide later (accounts/consent/keys), privacy notes,
  and that it is disabled by default. Update `README.md` status table (translation now local:
  IndicTrans2 verified on this laptop; LibreTranslate hi→en eligible but disabled until enabled;
  Groq audio fallback opt-in), `docs/setup.md`, `docs/architecture.md`, `docs/security.md`,
  `docs/event-runbook.md` (translation steps after the event, what labels mean, what to do when
  translation is unavailable), `docs/test-plan.md` (translation + integrations rows).

## Tests (must pass; current: server 355 + 1 skipped, app 376, rules 118, translator 34)
App: api validation, poller resume, migration 6 + repo (separate storage, session delete
cascades), viewer Translation tab labels for each engine incl. `und`/audio fallback and AI-polish
block, unavailable banner non-blocking, control hidden for non-finalized sessions, export
section labels, stream validator accepts `chunk_audio_translated` and ignores unknown types,
settings integration list. Server: integrations stubs + health + App Check non-blocking.

## Done when
All suites green; ruff/eslint/tsc clean. Report files changed, test counts, deviations.
