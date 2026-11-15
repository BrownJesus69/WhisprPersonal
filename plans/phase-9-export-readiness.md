# Phase 9 — Export and event readiness

**Working directory:** `E:\Whispr`. Read `E:\Whispr\AGENTS.md` (wins) and `android/AGENTS.md`.
**No network**, no new dependencies (the architect already installed **`expo-sharing@~58.0.23`**
in `android/`). Phases 1–8 are committed; reuse existing modules, repos, components, jest mocks,
pytest fixtures. Do not touch `secrets/`, `android/app/google-services.json`, any `.env`,
`.gitignore`, `AGENTS.md`. Do not run `git commit`. Never write scratch/test temp output into
`E:\Whispr\output\` — use your own temp dir (pytest `--basetemp` outside the repo, or a git-ignored
path). Server commands from `server/`: `./.venv/Scripts/python -m pytest -q -p no:cacheprovider
--basetemp=<temp>`, `ruff check .`, `ruff format --check .`. App: `npx tsc --noEmit`,
`npx eslint .`, `npx jest`.

## Goal
Make the system event-ready: export (Markdown + TXT, PDF shown as "not available yet"), a
read-only transcript viewer, brief viewer access from the Library, a diagnostics screen, the
speaker/term vocabulary screen, deleting a session from the phone (phone + laptop artifacts), and
complete documentation (README, setup incl. EAS + sideload, event runbook with rehearsal
checklist, test plan, status list).

## 1. Server — `POST /api/v1/export` (`app/routers/export.py`, `app/schemas/export.py`)
Protected like other endpoints (shared secret + token/grant), owner only.
Body `{event_id, session_ids: [1..20], format: "md"|"txt", text: "raw"|"polished" = "raw",
title: str ≤ 200 | null}`. Sessions must belong to the uid and event (else 404). Response: the
document as `text/markdown; charset=utf-8` or `text/plain; charset=utf-8` with
`Content-Disposition: attachment; filename="<safe-title-or-event>-transcript.<ext>"` (ASCII-safe
filename; strip path chars). Content: header (title or event id, export time UTC, sessions with
created time, model, transcript_status), then per session `[hh:mm:ss] text` lines from stitched
`raw_text` in sequence order (or `polished_text` when `text=polished` and present, else raw with
the line suffixed ` (not cleaned)`), language change markers `— Kannada —`, and explicit
`[part not transcribed]` for failed/missing sequences; no-speech chunks omitted. When
`text=polished` add a top note "AI-cleaned text; the raw transcript is unchanged on the laptop."
The server has no notes or briefs — the phone export includes those. Audit row
`transcript_exported`. Tests: md/txt content, polished fallback marker, ownership 404, auth
required, filename sanitizing, failed-part marker, no-speech omission. Update `docs/api.md`.

## 2. App — export (`android/src/lib/export/`)
- `compose.ts` (pure, fully tested): `composeEventExport({event, sessions, transcripts,
  languageEvents?, notes, brief?, format: 'md'|'txt', text: 'raw'|'polished'})` →
  `{filename, mimeType, content}`. Sections in order: event header (title, date/time, location,
  languages, privacy mode, export time); **Brief** (only if the user picked a saved brief; label
  "AI-generated brief, reviewed and saved by the owner" + provider/model; uses `finalText`);
  **Notes** (non-deleted, by timestamp: `[mm:ss] Speaker: text` + "(from transcript)" for
  transcript notes); **Transcript** per session (same rules as the server export, from local
  `transcript_chunks`; raw by default; polished option labelled; failed parts marked). TXT =
  same content without Markdown syntax. Filename `whisprpersonal-<slug(title)>-<YYYYMMDD>.<ext>`,
  ASCII slug, max 80 chars. Never include server keys, tokens, URLs with credentials, or device ids.
- `share.ts`: write with `expo-file-system` (`File`, `Paths.cache` → `exports/`), then
  `Sharing.shareAsync(uri, { mimeType, dialogTitle })` from `expo-sharing` (check
  `isAvailableAsync()`, show a clear error otherwise). Delete files in `exports/` older than 24 h
  on each export. **Do not add the `expo-sharing` config plugin** (it registers the app as a share
  *target*; we only send).
- **Export screen** `src/app/events/[eventId]/export.tsx` (button "Export" on the event screen):
  choose sessions (default all with transcript rows), Markdown/TXT, Raw/Cleaned, include notes
  (default on), include a saved brief (picker of saved briefs, default none), disabled "PDF — not
  available yet" option, Export button → share sheet. Works offline (all data local/cached).

## 3. App — transcript viewer and Library
- `src/app/transcript/[sessionId].tsx` (register route, title "Transcript"): read-only list from
  local SQLite rows; Raw/Polished tabs (reuse `TranscriptTabs`; same labels as the live screen);
  search box filtering rows (Unicode-safe, reuse `normalizeSearch`) with match count; optional
  `?sequence=` param scrolls to that row; header with session date, duration, language timeline,
  transcript status; "Add to notes" long-press like the live screen. No auto-follow.
- Event screen: each session row gets "View transcript"; buttons "Notes", "Briefs", "Export",
  "Vocabulary". Search results for transcripts open the viewer at the matching sequence.
- Library tab: keep past events; each opens the event screen (already) — ensure finalized/
  completed events show "View transcript", "Briefs" (saved brief viewer from 8b), "Export".

## 4. App — vocabulary (`src/app/events/[eventId]/vocabulary.tsx`, `lib/server` client calls)
Read server contract in `server/app/routers/vocabulary.py` + `schemas/vocabulary.py`. Load
`GET /api/v1/vocabulary?event_id=` (check exact query shape in the router), edit a list of terms
(names, places, jargon; each ≤ 64 chars, max 200 client-side), "Add event speakers" button
prefilling from `event.speakers`, Save → `POST /api/v1/vocabulary {event_id, terms,
replacements: []}`. Replacements are reserved on the server — do not expose them. Needs the
laptop: clear offline/unavailable state; explain that terms help Whisper spell names and apply to
chunks transcribed after saving.

## 5. App — delete a session
- `ServerClient.delete<T>(path)` (same auth/retry semantics as `get`).
- `lib/session/deleteSession.ts`: refuse while that session is recording/paused/stopping. If
  `server_created`: `DELETE /api/v1/sessions/{id}` (409 `session_busy` → "The laptop is still
  transcribing a part; try again in a moment"); 404 = already gone (continue). Then delete local
  audio (chunk files + master via existing `chunkFiles`/file helpers) and rows: `chunks`,
  `transcript_chunks`, `stream_events`, `language_events`, local `ai_jobs` referencing it,
  `recording_sessions` — one SQLite transaction for rows (add repo method + memory twin). Notes
  are event-level and are **kept** (say so). If the laptop is unreachable: offer "Delete on this
  phone only" with an explicit warning that the laptop copy remains (and how to delete it later:
  open the event while connected → the session list shows "Laptop copy remains" only if you
  track it; simplest acceptable: store a `pending_server_deletes(session_id, event_id)` row and
  retry it when the upload service next runs — implement this, with tests).
- Session screen: "Delete session" (destructive, confirm dialog: what is deleted, cannot be
  undone). Navigate back afterwards.

## 6. App — diagnostics (`src/app/diagnostics.tsx`, entry in Settings)
Two sections. **Laptop** (needs connection): `GET /api/v1/diagnostics` fields (status, model,
GPU, queue, chunk counts, average real-time factor, providers status, limits) — show as
key/value rows, never raw JSON dumps of unknown keys that could contain secrets (whitelist).
**Phone**: app version + versionCode (from `expo-constants` `Constants.expoConfig`), sign-in mode
(Firebase / offline pass with expiry time), server host (no key), network state, free/total disk
(`Paths.availableDiskSpace` / `totalDiskSpace`), local counts (sessions by status, chunks pending/
failed, notes pending/conflict/failed, AI jobs running, pending server deletes), last upload
error code. "Share diagnostics" → TXT via the share helper; content excludes transcript text,
note text, keys, tokens, device ids, full server URL credentials. Tests assert exclusions with
sentinel values.

## 7. Documentation (owner-facing, plain language)
- `README.md` (root): overview, ASCII architecture diagram (phone ↔ LAN/Tailscale ↔ laptop
  FastAPI + faster-whisper GPU; Firebase Auth/Firestore; optional Groq → SambaNova → local LLM),
  quick start (laptop: `server/start.bat`; phone: install APK, sign in, scan QR), feature list,
  security model summary, limitations, and **Status**: complete / disabled pending keys (Groq,
  SambaNova, Google Sign-In flag) / owner must configure (Email/Password sign-in in Firebase
  console, deploy Firestore rules + indexes, server `.env` shared secret, Firebase service
  account path, provider keys + model names, Tailscale optional) / not yet verified on a device.
- `docs/setup.md`: prerequisites; Firebase (enable Email/Password, deploy rules:
  `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project <id>` run by the
  owner); Groq; SambaNova (key + a model your account can access — nothing assumed); local
  Whisper (model download, GPU/CUDA notes, `av==17.0.0` pin); Android build — (a) local Windows
  build on E: (`android/scripts/windows-build`, link to `android/README.md`), (b) **EAS**:
  `npx eas-cli@latest login`, `npx eas-cli@latest init` (app.config.js is dynamic: add the
  printed `extra.eas.projectId` manually), upload the Firebase client config as a secret file
  variable: `npx eas-cli@latest env:set --name GOOGLE_SERVICES_JSON --type file --value
  ./app/google-services.json --visibility secret --environment preview`, then
  `npx eas-cli@latest build -p android --profile preview` (APK); install with
  `adb install -r <apk>` or by opening the build URL on the phone; **sideload**: enable "Install
  unknown apps" for the browser/file manager, Play Protect warning for debug-signed builds,
  versionCode must increase to install over an older build; LAN/Tailscale setup; troubleshooting
  table.
- `docs/event-runbook.md`: replace the Phase-3 placeholders with the full runbook — pre-event
  hardware checklist; model pre-download; battery/storage/thermals/power; Wi-Fi/hotspot setup;
  LAN/Tailscale connection test; language test recordings (Kannada, Tamil, Hindi, English,
  mixed); speaker-name vocabulary setup (new screen); offline sign-in (12 h pass) preflight;
  live-session failure drills (laptop Wi-Fi drop, laptop restart, app killed, screen locked,
  battery saver, server queue full); recovery procedures; notes, cleanup, brief; export
  procedure (phone export + server export); consent and privacy checklist; retention and
  deletion; a printable one-page **final rehearsal checklist** with tick boxes. Keep the
  verified facts already in the file (offline readiness, notes, cleanup sections) — merge, don't
  drop.
- `docs/test-plan.md`: automated suites and exact commands (server pytest, GPU opt-in test, app
  jest/tsc/eslint, Firestore rules emulator with env vars, live-stream-check driver) and a manual
  device test matrix mapped to the spec's Android test list (sign-in, event creation, server
  connection, mic permission, recording with screen locked, chunk creation, offline queue,
  upload retry, WebSocket reconnect, live transcript, notes, finalization, brief, app restart
  recovery, low connectivity, export, delete session) with expected results.
- `docs/architecture.md` / `docs/security.md`: add export, deletion, diagnostics exclusions.

## Tests (must pass; existing: server 306 + 1 skipped, app 340, rules 118)
Server export tests (section 1). App: compose (md/txt, raw/polished labels, notes ordering,
brief label, failed parts, slug/filename, no secrets), share helper (mocks file system + sharing,
cleanup of old files, unavailable sharing), viewer (search filter, polished fallback, sequence
param), vocabulary (load/save/validation/offline), delete (recording refusal, server 404/409,
offline pending delete + retry, rows removed in one transaction, notes kept), diagnostics
(whitelist, sentinel exclusions), routes registered. Extend `jest.setup.ts` mocks for
`expo-sharing` and `expo-file-system` `Paths` disk space as needed.

## Done when
All suites green, ruff clean, app bundles (`tsc`), docs complete per section 7. Report files
changed, test counts, deviations.
