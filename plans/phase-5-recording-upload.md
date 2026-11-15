# Phase 5 — Android recording, chunking, durable upload queue

**Working directory:** `E:\Whispr\android`. Read `E:\Whispr\AGENTS.md` (wins) and
`E:\Whispr\android\AGENTS.md`. **No network**: read APIs from `node_modules` `.d.ts`/source;
do not install anything. Phase 4 code is committed — follow its patterns (`ServerClient`,
`tokenManager`, `credentials`, zustand stores, `kv`, theme components, jest mocks in
`jest.setup.ts`, offline-safe Firestore writes via `background()` in `lib/firebase/events.ts`).

## Goal
Record event audio continuously (also with the screen locked), cut it into **gap-free,
overlapping** 16 kHz mono WAV chunks on the phone, persist every chunk before upload, and
upload through a durable SQLite queue with retry/backoff, idempotency, and crash recovery. No
live transcript UI yet (Phase 6) — but upload status and server transcription status per chunk.

## Owner decision (2026-11-15) and verified facts
- Recorder: **`@siteed/audio-studio` ^3.2.1** (MIT, installed). `expo-audio` was evaluated
  and rejected: its `AudioStream` (gap-free PCM) has no foreground service, and Android 9+ gives
  **silence** to background mic capture without one (developer.android.com "Sharing audio
  input"). `expo-audio`, `expo-keep-awake`, `expo-task-manager` were **uninstalled** — do not
  use them.
- audio-studio API (verify details in `node_modules/@siteed/audio-studio/build/types`):
  exports `AudioRecorderProvider`, `useSharedAudioRecorder`, `useAudioRecorder`,
  `AudioStudioModule`, `writeWavHeader`, `getWavFileInfo`. Hook returns
  `startRecording(config) / pauseRecording() / resumeRecording() / stopRecording() /
  isRecording / isPaused / durationMs`. `RecordingConfig` includes `sampleRate: 16000|44100|48000`,
  `channels: 1|2`, `encoding: 'pcm_16bit'|…`, `interval` (ms between stream events),
  `streamFormat: 'raw'` (**base64 PCM bytes on native**) | `'float32'`, `keepAwake`,
  `showNotification`, `notification {title,text,android:{…}}`, `output: { primary: { enabled,
  format:'wav' }, compressed?: … }`, `outputDirectory`, `filename`,
  `autoResumeAfterInterruption`, `onRecordingInterrupted(event {reason, isPaused})`,
  `onAudioStream(event: { data, position, fileUri, eventDataSize, totalSize, … })`,
  `android: { audioFocusStrategy }`, `bufferDurationSeconds`.
  Config plugin options: `enablePhoneStateHandling`, `enableNotifications`,
  `enableBackgroundAudio` (adds FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, WAKE_LOCK),
  `enableDeviceDetection` (adds BLUETOOTH*/USB permissions).
  Mic/notification permission helpers: find them in the module exports
  (`AudioStudioModule`); otherwise use `PermissionsAndroid` (RECORD_AUDIO, POST_NOTIFICATIONS
  on API 33+).
- `expo-file-system ~58` new API: `File`, `Directory`, `Paths` (`Paths.document`,
  `Paths.availableDiskSpace`), `file.open()` → `FileHandle` with `offset`, `size`,
  `readBytes(n)`, `writeBytes(bytes)`, `close()`. `expo-crypto ~58`:
  `digest(CryptoDigestAlgorithm.SHA256, bytes)` → ArrayBuffer.
- Laptop server contract (implemented, Phase 3/3b):
  - `POST /api/v1/sessions` JSON `{session_id (DocId [A-Za-z0-9_-]{1,128}), event_id,
    language_mode: "auto"|kn|ta|hi|en, expected_languages: [], model_profile: "turbo",
    overlap_ms: 0..3000}` → 201 new / 200 existing (idempotent) / 404 not owner.
  - `POST /api/v1/sessions/{id}/chunks` **multipart**: `chunk_id` (DocId), `sequence`
    (0..100000), `start_ms`, `end_ms`, `overlap_ms`, `continues` ("true"/"false"),
    optional `language`, optional `sha256` (64 hex), `file` (filename must end `.wav`).
    → **202** `{chunk_id, sequence, status:"queued", duplicate:false, queue_depth}`;
    **200** `{duplicate:true, status, chunk}` for an identical re-upload (treat as success);
    409 `chunk_conflict` (same id different bytes, or same sequence different id) — permanent;
    409 `session_finalized` — permanent; 413/415/422 — permanent; 503 `queue_full` with
    `Retry-After` — transient; 429 — transient (Retry-After); 404 — session missing on server
    → re-create session once, then retry. Max chunk audio 30 s + overlap.
  - `GET /api/v1/sessions/{id}?after_sequence=-1&limit=1000` → `chunks[] {chunk_id, sequence,
    status: queued|processing|done|failed, error_code, raw_text, …}`, `status`, `counts`.
  - `POST /api/v1/sessions/{id}/finalize` `{expected_chunk_count, force:false}` → 200
    finalized / 202 `{status:"finalizing", missing_sequences, pending}`.
  - Server stitches overlap seams itself; **send `overlap_ms` = the head overlap of each
    chunk** (0 for the first chunk of a run) and session `overlap_ms` = setting (1000–1500).

## Files
Modify: `app.config.js`, `package.json` (version 0.5.0; no deps changes), `jest.setup.ts`,
`src/lib/server/client.ts` (+ multipart), `src/lib/server/types.ts`,
`src/app/_layout.tsx` (wrap in `AudioRecorderProvider`; start upload service + recovery after
auth), `src/app/events/[eventId].tsx` (Start session), `src/app/(app)/settings.tsx`,
`src/state/settingsStore.ts` (+ `deleteLocalAudioAfterTranscription: false`),
`src/lib/firebase/events.ts` (reuse `updateEventStatus`), `android/README.md`.
Create:
```
src/lib/audio/pcm.ts            # base64ToBytes (no atob dependency issues: implement), wav
                                # header (RIFF/WAVE fmt PCM 16k mono 16-bit), levelDbfs(int16)
src/lib/audio/chunker.ts        # pure, deterministic (below)
src/lib/audio/chunkFiles.ts     # file naming/metadata, write chunk (header+pcm), sha256,
                                # list/parse orphans, read master WAV tail via FileHandle
src/lib/audio/recorder.ts       # thin adapter over audio-studio (start/pause/resume/stop,
                                # stream → chunker, interruptions) — no business logic
src/lib/db/database.ts          # expo-sqlite open + migrations (PRAGMA user_version)
src/lib/db/repositories.ts      # SessionRepo/ChunkRepo interfaces + SQLite implementation
src/lib/db/memoryRepositories.ts# in-memory implementation for tests
src/lib/upload/backoff.ts       # full-jitter exponential backoff, Retry-After precedence
src/lib/upload/uploadService.ts # durable queue worker (below)
src/lib/session/recordingStore.ts  # zustand state machine for the live session
src/lib/session/recovery.ts     # startup recovery (below)
src/app/session/[sessionId].tsx # live session screen
src/components/{LevelMeter,RecordControls,QueueStatus,ConsentDialog}.tsx
src/__tests__/{pcm,chunker,chunkFiles,backoff,uploadService,recovery,recordingStore}.test.ts
```

## Design

### app.config.js
- Remove `android.permission.RECORD_AUDIO` from `blockedPermissions`; add
  `android.permission.READ_PHONE_STATE`, `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_CONNECT`
  to `blockedPermissions` (defence in depth).
- Plugin `['@siteed/audio-studio', { enablePhoneStateHandling: false, enableNotifications:
  true, enableBackgroundAudio: true, enableDeviceDetection: false }]` with a comment explaining
  each (calls are still detected as audio-focus interruptions).
- `version: '0.5.0'`. Keep everything else (Kotlin 2.3.21 comment etc.) intact.

### Chunker (`chunker.ts`) — pure TS, no RN imports, fully unit-tested
```ts
interface ChunkSpec { sequence: number; startMs: number; endMs: number; overlapMs: number;
  continues: boolean; pcm: Uint8Array }   // pcm = 16-bit LE mono samples, no header
class Chunker {
  constructor(o: { sampleRate: 16000; chunkMs: number /*5000–15000*/; overlapMs: number
    /*1000–1500*/; startSequence?: number; startTimeMs?: number })
  push(pcm: Uint8Array): ChunkSpec[]    // may return 0..n chunks
  flush(reason: 'pause'|'stop'): ChunkSpec | null
  get timeMs(): number                  // session audio time consumed so far
  get nextSequence(): number
  state(): { nextSequence, timeMs, ... } // for persistence
}
```
- Timeline = **recorded audio time** in ms (pauses collapse); every sample counted exactly
  (work in samples, convert to ms with `Math.round(samples*1000/16000)`; 16 samples = 1 ms).
- Keep an odd trailing byte across `push` calls (never split a sample).
- Run starts (session start, after resume, after recovery): first chunk has `overlapMs = 0`.
- Subsequent chunks in the same run: `pcm = last overlapSamples of previous chunk's audio +
  next chunkSamples of new audio`; `overlapMs = overlapSamples/16`; `startMs = prevEndMs -
  overlapMs`; `endMs = startMs + duration`. `continues: true` for chunks emitted by `push`;
  the chunk returned by `flush` has `continues: false`.
- `flush` emits the remaining **new** audio (prefixed by overlap if the run already emitted a
  chunk) if it has ≥ 200 ms of new audio; otherwise it returns null and the few ms are dropped
  only if < 200 ms (document this). After `flush('pause')` the next push starts a new run.

### Chunk files (`chunkFiles.ts`)
- Dir: `Paths.document/whispr/sessions/{sessionId}/chunks/`. Name encodes metadata for crash
  recovery: `{sequence:06d}_{startMs}_{endMs}_{overlapMs}_{c|e}_{chunkId}.wav`
  (`c` continues / `e` end-of-run). `chunkId` = `crypto.randomUUID()` without dashes
  (expo-crypto `randomUUID`), lowercase hex → valid DocId.
- `writeChunk(sessionId, spec)` writes header+pcm to `…wav.part`, then renames to `.wav`
  (atomic on the same dir), computes sha256 (expo-crypto) of the **file bytes**, returns
  `{uri, sizeBytes, sha256}`. A `.part` file is never uploaded (deleted by recovery).
- Master file: audio-studio `output.primary` WAV at `…/sessions/{sessionId}/master.wav`
  (set `outputDirectory`/`filename`). `readWavPcm(uri, fromMs, toMs?)` uses `FileHandle`
  (seek to `44 + fromSample*2`; never read the whole file into memory; cap reads at 2 MB per
  call). Treat data length as `fileSize - 44` (header may be stale after a crash).

### SQLite (`database.ts`, `repositories.ts`) — db file `whispr.db`
Migrations via `PRAGMA user_version`. Tables:
- `recording_sessions(id TEXT PK (DocId: 'ses_' + 24 hex), event_id, owner_uid, status CHECK
  in ('recording','paused','stopped','interrupted','finalizing','finalized','failed'),
  language_mode, expected_languages TEXT(JSON), chunk_ms, overlap_ms, next_sequence,
  time_ms, master_uri, server_created INT, expected_chunk_count INT NULL, finalize_status,
  consent_at TEXT, created_at, updated_at, last_error TEXT)`.
- `chunks(chunk_id TEXT PK, session_id, sequence, start_ms, end_ms, overlap_ms, continues
  INT, uri, size_bytes, sha256, status CHECK in ('pending','uploading','uploaded',
  'transcribed','failed_permanent'), server_status TEXT, attempts INT, next_attempt_at REAL,
  last_error TEXT, local_deleted INT DEFAULT 0, created_at, updated_at, UNIQUE(session_id,
  sequence))`; index on `(status, next_attempt_at)`.
- Repos expose only what the services need; in-memory twin for tests. All writes are single
  transactions. `uploading` rows are reset to `pending` on startup (crash mid-upload).

### Upload service (`uploadService.ts`)
- Singleton started after sign-in when a server URL is configured; stoppable; one upload at a
  time (the laptop GPU is serial anyway). Triggers: chunk inserted, network reachable
  (`expo-network` listener), app foreground (`AppState`), connection settings changed, and a
  5 s timer while work is pending (cleared when idle).
- Order: oldest session first, ascending `sequence`; respects `next_attempt_at`.
- Before a session's first chunk: `POST /api/v1/sessions` (idempotent) → `server_created=1`.
- Upload via `ServerClient.postMultipart(path, form, {timeoutMs: 60000})` — add this to
  `client.ts`: same auth headers + single retry on `auth_token_expired`, **do not set
  Content-Type** (RN sets the boundary). FormData file part: `{ uri, name: <filename>,
  type: 'audio/wav' }`. Send `sha256`.
- Outcome mapping per the contract above. Transient → `pending`, `attempts+1`,
  `next_attempt_at = now + backoff(attempts, retryAfterS)`; **never give up on transient
  errors** (audio must not be lost) — cap delay at 5 min. Permanent → `failed_permanent` with
  `last_error` code; keep the file; surface in UI. Auth/config errors (`missing_server_key`,
  `invalid_server_key`, `server_not_configured`, `account_not_allowed`,
  `auth_not_configured`, `renew_required`) → pause the queue (no attempt increment), set
  connection store status, resume on settings/auth change.
- Status polling: while any chunk of a session is `uploaded` (not yet transcribed), `GET
  /api/v1/sessions/{id}` at most every 10 s → mark `transcribed` for server `done`; record
  `server_status` (`failed` stays visible). If `deleteLocalAudioAfterTranscription` is on,
  delete the chunk file **only after** `transcribed` (set `local_deleted=1`). Master WAV is
  never auto-deleted in Phase 5.
- Finalize: when a session is `stopped` and every chunk is `uploaded|transcribed` →
  `POST …/finalize {expected_chunk_count: next_sequence}`; 202 → `finalizing`, poll; 200 →
  `finalized`. Event status (background Firestore writes): `active` at recording start,
  `processing` at stop, `completed` when finalized.
- Pure helpers (backoff, outcome mapping, next-work selection) are unit-tested; the loop is
  tested with memory repos, a fake clock, and a mocked client.

### Recording store + recorder adapter
State machine: `idle → requesting_permission → ready → recording ⇄ paused → stopping →
stopped` (+ `error`). Start requires: signed in, mic permission (request **only** on Start),
POST_NOTIFICATIONS requested on API 33+ (recording works without it but warn), explicit
consent for this session via `ConsentDialog` ("Everyone being recorded has been told and
agrees", checkbox + confirm; store `consent_at`), ≥ 500 MB free (`Paths.availableDiskSpace`)
else block with message, < 2 GB → warning. **Server connection is NOT required to start**
(offline queue). Recorder config: `sampleRate 16000, channels 1, encoding 'pcm_16bit',
interval 500, streamFormat 'raw', keepAwake true, showNotification true, notification {title:
'WhisprPersonal is recording', text: event title}, output {primary {enabled true, format
'wav'}}, outputDirectory/filename = master path, autoResumeAfterInterruption false,
android {audioFocusStrategy 'background'}`. `onAudioStream`: base64 → bytes → level meter
(throttle UI to ~10 Hz) → `chunker.push` → for each spec `writeChunk` + insert row (serialize
these writes with a promise queue so order is preserved) → `uploadService.notify()`. Persist
chunker state (`next_sequence`, `time_ms`) with each chunk insert. `onRecordingInterrupted`
→ flush('pause'), state `paused` with banner "Recording paused: <reason>. Tap Resume." Pause
→ `pauseRecording` + flush('pause'); Resume → `resumeRecording` (new run, overlap 0 on its
first chunk); Stop → `stopRecording` + flush('stop') + status `stopped` + event `processing`.
Never block the stream callback on network.

### Recovery (`recovery.ts`, run once after sign-in, before the upload service)
1. Delete `*.wav.part` files. 2. `uploading` → `pending`. 3. Orphan `.wav` chunk files with no
row → parse name, recompute sha256, insert as `pending`. 4. Sessions in `recording|paused`
with no live native recording → `interrupted`: read the master WAV from `time_ms -
overlap_ms` to the end via `readWavPcm`, feed a `Chunker` started at `next_sequence`/
`time_ms - overlap`, emit chunks (first one carries `overlap_ms`), flush('stop'), insert, set
session `stopped`. The live screen offers "Resume recording" for interrupted sessions (a new
run appended to the same session). 5. Notify the upload service.

### Live session screen (`session/[sessionId].tsx`)
Large Start/Pause/Resume/Stop (≥ 64 dp, confirm before Stop), elapsed recorded time,
`LevelMeter` (dBFS bar with clipping indication), connection pill, `QueueStatus` (recorded /
uploaded / transcribed / failed counts; "N chunks waiting — offline" when the laptop is
unreachable; retry button for `failed_permanent` showing the error code), banner explaining
that recording continues with the screen locked (notification visible), placeholder card
"Live transcript arrives in the next update". Event detail screen: "Start session" creates a
local session (status `ready`) and navigates here; list of previous local sessions for the
event with their status.

### Settings additions
"Delete phone audio after the laptop transcribes it" (default off); storage used by
recordings; "Delete transcribed chunk audio now" (only `transcribed` chunks; confirm).

## Tests (jest-expo, offline)
- `pcm`: base64 round trip incl. padding; WAV header bytes (sizes, 16000 Hz, 1 ch, 16-bit,
  byte rate 32000, block align 2); level of silence = -Infinity/-96 floor, of full-scale ≈ 0.
- `chunker` (most important): exact sample counts for 10 s/1.2 s; chunk k (k≥1) `pcm` starts
  with exactly the last overlap bytes of chunk k-1's audio; `startMs/endMs/overlapMs`
  arithmetic; first chunk of a run overlap 0; pushes of odd byte sizes and tiny buffers give
  identical output to one big push (property-style loop over random split points with a
  seeded PRNG); concatenating each chunk's non-overlap part reproduces the input exactly
  (**no lost or duplicated samples**); pause → flush (continues=false) → resume starts new run;
  flush < 200 ms new audio returns null; sequences monotonic across runs.
- `chunkFiles`: name encode/parse round trip; `.part` never listed as uploadable;
  `readWavPcm` seeks correctly (mock FileHandle).
- `backoff`: bounds, cap 5 min, Retry-After wins, monotone envelope.
- `uploadService`: creates server session once; uploads in sequence order; 202 and 200-duplicate
  → uploaded; 409/413/415/422 → failed_permanent (file kept); network/timeout/429/503 →
  pending with backoff, never permanent; 404 → recreate session once; auth errors pause without
  attempt increments; polling marks transcribed; deletion only after transcribed and only when
  the setting is on; finalize only when all uploaded, with `expected_chunk_count`.
- `recovery`: `.part` removed; orphan reinserted with metadata from name; uploading→pending;
  interrupted session tail re-chunked from master WAV (mock) with correct sequences/overlap.
- `recordingStore`: cannot start without consent / permission / disk; pause/resume/stop
  transitions; interruption → paused.

## Done when (architect verifies)
1. `npx tsc --noEmit`, `npx eslint .`, `npx jest` all clean. 2. `npx expo export --platform
android` bundles. 3. `npx expo config --type introspect` shows RECORD_AUDIO and
FOREGROUND_SERVICE_MICROPHONE requested, READ_PHONE_STATE/BLUETOOTH* not requested.
4. Add `scripts/make-test-chunks.mjs` (plain Node ESM, no RN imports): reads a 16 kHz mono
16-bit WAV path + chunkMs + overlapMs from argv, runs the **same chunker logic** (import the
compiled-free TS by keeping `chunker.ts`/`pcm.ts` free of RN imports and providing a tiny
`.mjs` twin OR use `node --experimental-strip-types` if available in node v24 — prefer the
latter: `node --experimental-strip-types scripts/make-test-chunks.ts`) and writes
`{seq}_{start}_{end}_{overlap}_{c|e}.wav` files to an output dir. The architect will upload
these to the real laptop server to verify end-to-end stitching.
5. README: recording permissions, notification, battery/screen-lock behaviour, storage use
(~115 MB/hour master + chunks), offline queue, retention setting, recovery.
6. No secrets, no edits to `google-services.json`, `server/`, root `.env`, `secrets/`.

## Report back
Files, command outputs, deviations with reasons, what needs a real device to verify.
