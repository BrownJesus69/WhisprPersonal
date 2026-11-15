# Phase 6 — Live transcript (WebSocket, resume, language badge + override)

**Working directory:** `E:\Whispr\android`. Read `E:\Whispr\AGENTS.md` (wins) and
`E:\Whispr\android\AGENTS.md`. **No network**; read APIs in `node_modules`. Phases 4–5 are
committed — reuse `ServerClient`, `tokenManager` (`getBearer`, `onAuthExpired`),
`credentials`, `settingsStore`, `connectionStore`, the SQLite repos (`lib/db/*`, migrations by
`PRAGMA user_version`, memory twin for tests), `uploadService`, `recordingStore`, theme
components, and the jest mocks in `jest.setup.ts`.

## Goal
On the live session screen show a continuously updating transcript from the laptop: partial
segments while a chunk is being decoded, finalized chunk text, **revisions** when a seam is
re-stitched, a detected-language badge with confidence/uncertainty, a language timeline, and
a manual override (Auto / Kannada / Tamil / Hindi / English) that works even when the laptop
is temporarily unreachable. Resilient WebSocket with resume. Raw and polished text clearly
separated (polished = Phase 8; show a disabled "Polished" tab). Persist finals locally so the
transcript survives app restarts and is viewable offline.

## Verified facts (architect)
- React Native 0.88 `WebSocket` supports headers: `new WebSocket(url, protocols, { headers })`
  (`node_modules/react-native/Libraries/WebSocket/WebSocket.js`). The TS DOM lib type may not
  declare the 3rd parameter — wrap construction in one typed factory with a comment.
- **Server stream contract** (implemented; `server/app/routers/stream.py`):
  - URL: `ws(s)://<laptop>/api/v1/sessions/{session_id}/stream?after_seq=<int ≥ 0>` — derive
    from the validated server URL (`http→ws`, `https→wss`). Auth **only via headers**:
    `X-WhisprPersonal-Server-Key`, `Authorization: Bearer <pass or Firebase token>`; never put
    credentials in the URL.
  - On auth/ownership failure the server sends `{"type":"error","code","message"}` then closes:
    **4401** (missing/invalid key or token, `auth_token_expired`), **4403**
    (`account_not_allowed`), **4404** (session not on server / not yours), **4429** (rate
    limited), **4503** (auth unavailable / not configured), **4400** other validation.
    **4008** = this subscriber overflowed → reconnect immediately with `after_seq`.
    **1000** after `session_deleted`. **1008** from the LAN network filter.
  - After accept: `{"type":"hello","session_id","status","last_event_seq","server_time"}`, then
    replay of persisted events with `seq > after_seq` in order, then live events.
  - Persisted envelope: `{"type","seq","session_id","ts","data"}`. Types and `data`:
    `session_created {event_id}`; `chunk_queued {chunk_id, sequence}`; `chunk_processing
    {chunk_id, sequence}`; `transcript_final` and `transcript_revised` (**same shape; revised
    replaces the chunk's text**) `{chunk_id, sequence, start_ms, end_ms, raw_text, segments:
    [{start_ms, end_ms, text}] (session-timeline ms), detected_language, language_confidence,
    language_source: "auto"|"locked"|"override", language_uncertain, no_speech}`;
    `chunk_failed {chunk_id, sequence, error_code}`; `language_locked {language, confidence,
    at_sequence}`; `language_changed {from, to, at_sequence}`; `language_override {language,
    by}`; `session_finalizing`; `session_finalized {transcript_status, missing_sequences,
    failed_sequences}`; `session_deleted`.
  - Ephemeral (no `seq`): `{"type":"transcript_partial","session_id","chunk_id","sequence",
    "data":{"start_ms","end_ms","text"}}` — times are **relative to the chunk**.
  - Server sends `{"type":"ping"}` every 20 s. Client may send `{"type":"pong"}` and
    `{"type":"set_language","language":"auto"|"kn"|"ta"|"hi"|"en"}` (≤ 4 KiB). Unknown/invalid →
    `{"type":"error","code":"bad_request"}` and the connection stays open.
- HTTP: `POST /api/v1/sessions/{id}/language {language}` → returns language state; 409
  `session_finalized` after finalization. Chunk upload accepts an optional per-chunk
  `language` form field (a supported code, **not** "auto") that forces that chunk's language.
  `GET /api/v1/sessions/{id}` returns `chunks[]` with `raw_text`, `segments`,
  `detected_language`, `language_confidence`, `language_source`, `language_uncertain`,
  `no_speech`, `status`, `error_code`, plus `language {mode, locked, segments:[{language,
  from_sequence, to_sequence}]}` and `last_event_seq`.

## Files
Create:
```
src/lib/live/socket.ts          # WebSocketLike interface + RN factory (headers) — the only
                                # place that constructs a WebSocket
src/lib/live/streamClient.ts    # RN-free core: connect/reconnect/resume/watchdog/dispatch;
                                # deps injected (socket factory, getBearer, getServerKey,
                                # onAuthExpired, clock/timers, persistence callbacks)
src/lib/live/events.ts          # typed event union + runtime validation (reject malformed)
src/lib/live/transcriptModel.ts # pure reducer: apply(state, event) → state
src/lib/live/transcriptStore.ts # zustand per-session view state; hydrate from SQLite
src/lib/live/liveController.ts  # wires streamClient ↔ store ↔ repos ↔ upload service;
                                # start/stop per open session screen + while recording
src/lib/live/languageOverride.ts# local override + WS/HTTP propagation
src/components/{TranscriptList,TranscriptRow,LanguageBadge,LanguagePicker,LiveStatusPill,
  TranscriptTabs}.tsx
src/__tests__/{streamClient,transcriptModel,languageOverride,transcriptRepo}.test.ts
src/__tests__/fakeSocket.ts
scripts/live-stream-check.ts    # Node 24 (type stripping) e2e driver — see "Architect check"
```
Modify: `src/lib/db/database.ts` (migration 2), `repositories.ts` + `memoryRepositories.ts`,
`src/lib/upload/uploadService.ts` (per-chunk `language` field; feed poll results into the
transcript repo), `src/app/session/[sessionId].tsx` (transcript UI), `README.md`,
`package.json` version `0.6.0`, `app.config.js` version `0.6.0`.

## Design

### SQLite migration 2
- `transcript_chunks(session_id, sequence, chunk_id, start_ms, end_ms, raw_text,
  segments_json, detected_language, language_confidence REAL, language_source,
  language_uncertain INT, no_speech INT, failed_code TEXT NULL, revision INT DEFAULT 0,
  updated_at, PRIMARY KEY(session_id, sequence))`.
- `language_events(session_id, seq, type, language, from_language, at_sequence, confidence,
  created_at, PRIMARY KEY(session_id, seq))`.
- `recording_sessions` add: `last_event_seq INT NOT NULL DEFAULT 0`, `language_override TEXT
  NOT NULL DEFAULT 'auto'`, `override_from_sequence INT NULL`, `server_finalized_at TEXT NULL`.
- Repo methods: `upsertTranscript(row)` (revision++ when text changes), `transcript(sessionId)`
  ordered by sequence, `appendLanguageEvent`, `languageEvents`, `setLastEventSeq` (monotonic:
  never decreases unless `resetLastEventSeq`), `setLanguageOverride(mode, fromSequence)`.
  Persisting an event and advancing `last_event_seq` happen in **one transaction** so a crash
  can't skip an event.

### streamClient (RN-free, fully unit-tested with fake timers + FakeSocket)
- `start(sessionId)`: requires the session to exist on the server (`server_created = 1`;
  otherwise wait — the controller re-calls start when the upload service creates it).
- URL built from the validated server URL; `after_seq` = stored `last_event_seq`.
- `hello`: if `hello.last_event_seq < localLastSeq` (server DB was reset) → reset local
  `last_event_seq` to 0 and re-sync (replay will re-deliver; upserts are idempotent).
- Persisted events: ignore `seq <= lastSeq` (dedupe across replay/live boundary and
  reconnects); validate shape (drop + log code-only if malformed); apply; persist.
- `transcript_partial`: ephemeral only (store), throttled to ≤ 5 UI updates/s.
- `ping` → send `pong`. Watchdog: no inbound message for **50 s** → close + reconnect.
- Close/error handling: 4008 → reconnect immediately (no backoff increment); 4401 → call
  `onAuthExpired()` once, then reconnect with backoff (if it fails again → status
  `auth_required`, stop until credentials change); 4403 → status `not_allowed`, stop; 4404 →
  status `waiting_for_server`, retry every 30 s (session may not be created yet); 4429 →
  backoff ≥ 10 s; 1000 after `session_deleted` → stop; everything else (network, 1006, 4503,
  1008) → full-jitter backoff 1 s → 30 s cap, attempt counter shown in UI. Reset attempt
  counter after 30 s of healthy connection.
- `setLanguage(mode)`: send over WS when open; resolve false when not open (caller falls back).
- `stop()`: clears timers, closes with 1000, removes listeners. Idempotent.
- Never log headers, tokens, or transcript text (code-only logging).

### transcriptModel (pure reducer)
State: `{ finals: Map<sequence, Row>, partials: Map<sequence, Segment[]>, failed:
Map<sequence, code>, language: { mode, locked?, current?, confidence?, uncertain, timeline:
[{language, fromSequence, toSequence}] }, finalized?: {transcriptStatus, missing, failed},
lastSeq }`. Rules: final/revised replace by sequence and clear that sequence's partials;
partial for a sequence that already has a final is ignored; failed marks the row;
`language_locked/changed/override` update language state; timeline computed from finals
(consecutive same `detected_language`, skipping `no_speech`). `current` = detected language of
the latest non-silent final.

### Language override (`languageOverride.ts`)
- `setOverride(sessionId, mode)`: persist `language_override = mode` and
  `override_from_sequence = <next chunk sequence the recorder will produce>` (from the
  recording store/chunker state) **before** any network call.
- Upload service: for chunks with `sequence >= override_from_sequence` and override ≠ "auto",
  add form field `language=<code>`. This makes the override effective for every later chunk
  even if the laptop was unreachable when the user tapped it.
- Best effort: `streamClient.setLanguage(mode)`; if not connected → `POST
  /api/v1/sessions/{id}/language`; if that also fails, keep it local (per-chunk field still
  applies) and retry the HTTP call when the stream reconnects. 409 `session_finalized` → ignore.
- Setting back to "auto" stops the per-chunk field and sends `auto`.

### Upload service changes
- Per-chunk `language` as above.
- When its existing status poll (GET session) returns chunks with `status == "done"`, upsert
  them into `transcript_chunks` (fallback when the WebSocket is down) — same idempotent upsert.

### UI (`session/[sessionId].tsx` and components)
- Header row: `LiveStatusPill` (Live · Reconnecting (n) · Waiting for laptop · Offline —
  transcript will catch up · Sign-in renewal needed · Not allowed), `LanguageBadge`
  ("Kannada · 92%", amber "?" + "uncertain" when `language_uncertain`, "Forced: Tamil" when
  overridden), `LanguagePicker` (chips Auto/Kannada/Tamil/Hindi/English; selecting shows a toast
  "Applies from the next chunk").
- `TranscriptTabs`: **Raw** (default) | **Polished** (disabled; caption "Cleanup arrives with
  Cloud AI later. Your raw transcript is always kept unchanged.").
- `TranscriptList` (FlatList keyed by sequence, memoized rows): each row shows `mm:ss` from
  `start_ms`, text; a language divider ("— Tamil —") when the language differs from the
  previous non-silent row; partial rows dimmed/italic with a trailing "…"; failed rows "Could not
  transcribe this part (code). Audio is kept on the phone."; `no_speech` rows hidden (count shown
  as "N silent chunks" footer). Revised rows update in place (subtle "updated" flash ≤ 600 ms,
  respect reduce-motion). Auto-scroll to bottom unless the user scrolled up → "Jump to live".
- Session controls from Phase 5 remain; transcript panel fills remaining space. Accessible
  labels; text selectable; large font option uses existing typography.
- Works for stopped/finalized sessions too (read-only, hydrated from SQLite; stream connects
  only to catch up and disconnects after `session_finalized`).

### liveController lifecycle
Start when the session screen mounts **or** a recording is active (keep live while recording
even if the user navigates away), stop on unmount when not recording, and after
`session_finalized` + transcript fully synced. React to: server URL/credential changes
(restart), `server_created` flipping to 1 (start), AppState foreground (immediate reconnect
attempt if not live).

## Tests (jest-expo, offline; FakeSocket + fake timers)
- `streamClient`: URL `http→ws`/`https→wss` + `after_seq`; headers contain key + bearer and the
  URL contains neither; hello → replay applied in order, `seq <= last` ignored, last seq
  persisted per event; hello with lower server seq → reset to 0; partial not persisted;
  ping→pong; watchdog reconnect after 50 s silence; close codes mapping (4008 immediate,
  4401 refresh-then-reconnect then `auth_required` on second 4401, 4403 stop, 4404 30 s,
  4429 ≥ 10 s, 1006 jittered backoff within bounds and capped, attempt reset after 30 s healthy);
  `setLanguage` sends JSON only when open; `stop` idempotent, no timers left.
- `transcriptModel`: final→revised replaces text; partial cleared by final and ignored after
  final; out-of-order sequences sorted; failed row; timeline with no_speech skipped; current
  language; finalized flag.
- `languageOverride`: persisted before network; per-chunk field only for sequence ≥ from and
  mode ≠ auto; WS used when open, HTTP fallback, local-only when both fail, retried on
  reconnect; 409 ignored; back to auto clears field.
- `transcriptRepo` (memory + SQL statement shape): upsert idempotent, revision increments only
  on text change, `last_event_seq` monotonic and stored in the same transaction as the event.
- Upload-poll fallback upserts done chunks.

## Architect check (`scripts/live-stream-check.ts`, Node 24 runs `.ts` with
`node --experimental-strip-types`)
Imports the **production** `streamClient.ts`, `transcriptModel.ts`, `events.ts` (therefore
these files must not import React Native/Expo modules — inject everything). Uses Node 24's
global `WebSocket` as the socket factory: `new WebSocket(url, { headers })` — **verified by the
architect to send custom headers** (a local server received both headers). Args: `--server http://127.0.0.1:8770 --key <serverKey> --token <bearer>
--session <id> --event <eventId> --chunks <dir of make-test-chunks output> --overlap 1200
[--language ta]`. Steps: POST session (idempotent) → start streamClient → upload chunks via
`fetch` + `FormData` (`Blob` of the file, filename preserved, all form fields incl. sha256)
→ print each applied event type + seq → wait for all finals → POST finalize → wait for
`session_finalized` → print the reduced transcript text and language state → exit 0.
Also exercise one forced reconnect mid-run (call the client's internal `socket.close(4008)` via a
test hook) and confirm no event is lost or duplicated (print the seq list).

## Done when
`npx tsc --noEmit`, `npx eslint .`, `npx jest` clean; `npx expo export --platform android`
bundles; README documents the live transcript, reconnect behaviour, override semantics
("applies from the next chunk; works offline"), and raw vs polished. No secrets; no edits to
`server/`, `google-services.json`, `.env`, `secrets/`.

## Report back
Files, command outputs, deviations with reasons, device-only items.
