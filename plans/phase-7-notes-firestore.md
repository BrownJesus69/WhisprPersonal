# Phase 7 — Notes and Firestore sync (offline-first, conflict-safe, searchable)

**Working directory:** `E:\Whispr` (app code in `E:\Whispr\android`). Read `E:\Whispr\AGENTS.md`
(wins) and `E:\Whispr\android\AGENTS.md`. **No network** in your sandbox; read library APIs in
`node_modules`. Phases 4–6 are committed — reuse the SQLite repos (`lib/db/*`, migrations by
`PRAGMA user_version`, the `MemoryRepositories` twin for tests), `uploadService`'s lifecycle
pattern, `lib/firebase/events.ts` (offline-safe `background()` writes), theme components, and the
jest mocks in `android/jest.setup.ts`. Do **not** run `git commit`. Do not touch `secrets/`,
`android/app/google-services.json`, any `.env`, `.gitignore`, or `AGENTS.md`. No server changes in
this phase.

## Goal
Let the owner take notes during and after an event: **manual notes** (stamped with the
recording time when taken during a session), **transcript-derived notes** (from a finalized
transcript row), with timestamp, optional speaker label (picked from the event's speaker list),
**edit and delete**, and **search** across notes and transcripts. Notes are stored on the phone
first (SQLite = source of truth on the device), work fully offline, and sync to Firestore
`events/{eventId}/notes/{noteId}` through a **durable local outbox** with **conflict-safe
updates** (no silent lost update, no resurrection of deleted notes). AI-assisted notes are
Phase 8: show them as "not configured" only.

## Verified facts (architect)
- `@react-native-firebase/firestore` 27 modular API exports `doc, collection, setDoc,
  getDocFromServer, onSnapshot, query, orderBy, limit, serverTimestamp, Timestamp`
  (`node_modules/@react-native-firebase/firestore/lib/modular/*.ts`). Errors are
  `NativeFirebaseError` with `code` = `"firestore/<code>"`, e.g. `firestore/permission-denied`,
  `firestore/unavailable`.
- Firestore write promises resolve only on **server acknowledgement**; offline they stay
  pending (Firestore persists and retries them itself, in order, across restarts). Never block
  UI on them (see `background()` in `lib/firebase/events.ts`).
- `onSnapshot` delivers local pending writes first; `docSnapshot.metadata.hasPendingWrites`
  is `true` for those. Use `{ includeMetadataChanges: true }`.
- RNFirebase serializes JS safe integers as Firestore **integers** (`lib/utils/serialize.ts`),
  so rules may use `is int`.
- The Firestore emulator works on this machine (architect ran it): `firebase/rules-tests/`
  has `firebase-tools`, `@firebase/rules-unit-testing`, `firebase` installed and an emulator
  jar cached at `E:\whispr-build-cache\firebase-emulators`. Run with env
  `FIREBASE_EMULATORS_PATH=E:/whispr-build-cache/firebase-emulators`
  `XDG_CONFIG_HOME=E:/whispr-build-cache/firebase-config` then `npm test` in
  `firebase/rules-tests` (uses `firebase emulators:exec --project demo-whisprpersonal`, Node 24
  `node --test --experimental-strip-types`). It binds `localhost:8080`; if your sandbox cannot,
  say so in the report — the architect will run it.
- Server already writes sessions + finalized chunks to Firestore at session finalize
  (`server/app/services/firestore_sync.py`); the app does not write chunks.

## Firestore note contract — `events/{eventId}/notes/{noteId}`
Exactly these keys (all required, nullable where shown):

| key | type | notes |
|---|---|---|
| `ownerId` | string | `request.auth.uid` |
| `source` | `'manual' \| 'transcript' \| 'ai'` | `ai` reserved for Phase 8 |
| `text` | string ≤ 5000 | `''` **iff** `deleted == true` |
| `timestampMs` | int ≥ 0 \| null | offset into the session recording |
| `speaker` | string ≤ 100 \| null | |
| `sessionId` | string ≤ 128 \| null | local recording session id |
| `sequence` | int ≥ 0 \| null | transcript chunk sequence (transcript notes) |
| `language` | string ≤ 8 \| null | detected language of the source row |
| `deleted` | bool | tombstone; text and speaker cleared |
| `revision` | int ≥ 1 | server version after this write |
| `baseRevision` | int ≥ 0, < revision | server version this edit was based on |
| `deviceId` | string 8–64 | random per-install id (not a secret) |
| `createdAt` | timestamp | **client** time, fixed forever (deterministic → idempotent re-push) |
| `updatedAt` | timestamp | `serverTimestamp()` (rules: `== request.time`) |

Note ids are generated on the device: `note_` + 32 hex chars from `expo-crypto`
`randomUUID()` without dashes.

### Conflict rule (compare-and-set, enforced in `firestore.rules`)
- **create**: doc absent, `validNote()`.
- **update** allowed iff `validNote()`, `ownerId`, `createdAt`, `source` unchanged, and one of:
  1. `request.revision > resource.revision && request.baseRevision == resource.revision`
     (edit based on the latest server version), or
  2. `request.revision > resource.revision && request.deviceId == resource.deviceId`
     (the same device advancing its own writes — covers Firestore's queued intermediate
     writes and app restarts), or
  3. idempotent re-push: `request.revision == resource.revision &&
     request.deviceId == resource.deviceId &&
     request.resource.data.diff(resource.data).affectedKeys().hasOnly(['updatedAt','baseRevision'])`.
- **delete** (hard): owner only (unchanged). The app uses tombstones, never hard delete.
- Keep every existing rule for events/sessions/chunks/briefs/users unchanged.

## SQLite migration 3 (`android/src/lib/db/database.ts`)
```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, owner_uid TEXT NOT NULL,
  session_id TEXT, sequence INTEGER,
  source TEXT NOT NULL CHECK(source IN ('manual','transcript','ai')),
  text TEXT NOT NULL, search_text TEXT NOT NULL,
  timestamp_ms INTEGER, speaker TEXT, language TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,            -- version this device intends to publish
  synced_revision INTEGER NOT NULL DEFAULT 0, -- latest server version seen/acked (0 = never)
  remote_device TEXT,                   -- deviceId of the server version at synced_revision
  sync_state TEXT NOT NULL CHECK(sync_state IN ('pending','synced','conflict','failed')),
  remote_json TEXT,                     -- server copy while in conflict
  last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX notes_event ON notes(owner_uid, event_id, deleted, timestamp_ms);
CREATE INDEX notes_sync ON notes(owner_uid, sync_state, next_attempt_at);
PRAGMA user_version = 3;
```
`search_text` = `normalizeSearch(text + ' ' + (speaker ?? ''))` where
`normalizeSearch(s) = s.normalize('NFC').toLocaleLowerCase()` (keeps Kannada/Tamil/Devanagari
marks; SQLite `lower()` is ASCII-only, so normalize in JS). Search uses
`LIKE ? ESCAPE '\'` with `%`, `_`, `\` escaped. Do **not** use FTS5 (unicode61 tokenization
of Indic combining marks is unreliable).

## Files
Create:
- `android/src/lib/notes/model.ts` — types (`Note`, `NoteSource`, `RemoteNote`, `NoteInput`),
  `validateNoteInput`, `normalizeSearch`, `escapeLike`, `newNoteId`, and the **pure** sync
  decisions: `mergeRemote(local | null, remote, myDevice) → action` and
  `onRejected(local, serverDoc | null, myDevice) → action` (see Sync engine). Pure functions,
  exhaustively unit-tested.
- `android/src/lib/notes/deviceId.ts` — get-or-create the per-install id in `lib/storage/kv`.
- `android/src/lib/notes/notes.ts` — app API over the repo: `createNote`, `editNote`,
  `deleteNote` (tombstone: text `''`, speaker null, deleted 1), `keepMine(noteId)`,
  `useCloud(noteId)`, `retryFailed(noteId)`, `listNotes(owner, eventId, search?)`,
  `searchAll(owner, query)`; **every** local mutation bumps
  `revision = max(revision, synced_revision) + 1` (never reuse a revision that may already be
  in flight: a second write with the same revision but different text would be denied by rule
  clause 3 and then mistaken for an ack), sets `sync_state='pending'` (a note in `conflict`
  stays `conflict`; edits there update local text only), then calls `noteSync.notify()`.
  A brand-new note starts at `revision = 1`, `synced_revision = 0`.
- `android/src/lib/notes/noteSync.ts` — RN-free `NoteSyncEngine` (injected repo, remote,
  deviceId, clock) + a thin singleton wrapper (`start(owner)`, `stop()`, `notify()`, network
  and AppState listeners via `expo-network`/`AppState`, like `uploadService`).
- `android/src/lib/firebase/notes.ts` — Firestore adapter implementing
  `NoteRemote { push(note, deviceId): Promise<void>; fetchFromServer(eventId, id):
  Promise<RemoteNote | null>; subscribe(eventId, onDocs, onError): () => void }` plus
  `toFirestore(note, deviceId)` / `fromFirestore(id, data)` (strict: reject docs missing
  required keys or with wrong types → ignored, logged as `invalid_remote_note`).
  `push` = `setDoc(ref, data)` (full document, no merge). `subscribe` =
  `onSnapshot(query(collection(db,'events',eventId,'notes'), orderBy('createdAt'), limit(500)),
  { includeMetadataChanges: true }, …)` passing `{ note, pending: doc.metadata.hasPendingWrites }`.
- `android/src/app/events/[eventId]/notes.tsx` — notes for one event: search box, list
  (timestamp `mm:ss` when present, speaker, source chip "Manual"/"From transcript", sync chip
  "Saved on phone · syncing" / "Synced" / "Conflict" / "Not saved to cloud"), add note, edit
  (modal editor: text, speaker chips from `event.speakers` + "None"), delete with confirm,
  conflict card ("Changed on another device" showing both texts: **Keep mine** / **Use cloud**),
  disabled "AI-assisted notes · not configured" row.
- `android/src/app/search.tsx` — search notes **and** local transcript text for the signed-in
  owner (min 2 chars, debounce 250 ms, max 50 results each, newest first); a note result opens
  the event notes screen; a transcript result opens `/session/[sessionId]`.
- `android/src/components/NoteRow.tsx`, `NoteEditor.tsx`, `QuickNote.tsx`, `SyncChip.tsx`.
- Tests (jest-expo, offline): `notesModel.test.ts`, `noteRepo.test.ts`, `noteSync.test.ts`,
  `notesFirestore.test.ts`, `notesUi.test.tsx`.
- `firebase/rules-tests/test/notes.test.ts`, `firebase/rules-tests/test/existing.test.ts`
  (events owner create/read/update/deny, secret-like key rejected, chunk text limit), and
  delete `firebase/rules-tests/test/smoke.test.ts`. Add `firebase/rules-tests/README.md`
  (how to run, env vars above). Keep `package.json`/`package-lock.json` (already present).

Modify:
- `android/src/lib/db/repositories.ts` / `memoryRepositories.ts` — `NoteRepo` (`putNote`,
  `note`, `notes(owner,eventId,search?)`, `pendingNotes(owner, now)`, `updateNote`,
  `searchNotes(owner,q,limit)`, `searchTranscripts(owner,q,limit)` joining
  `transcript_chunks` → `recording_sessions` on `owner_uid`, `no_speech=0`); add to
  `Repositories`. Memory twin must mirror SQL semantics (owner isolation, ordering, LIKE).
- `android/src/app/events/[eventId].tsx` → move to `android/src/app/events/[eventId]/index.tsx`
  (keep behaviour) and add a "Notes (n)" button; register routes in `src/app/_layout.tsx`
  (`events/[eventId]/index`, `events/[eventId]/notes` titled "Notes", `search` titled
  "Search").
- `android/src/app/(app)/library.tsx` — add a "Search notes and transcripts" button above the
  list.
- `android/src/app/session/[sessionId].tsx` — `QuickNote` input under the controls ("Add
  note", stamps `timestampMs` = current elapsed recording ms when this session is
  recording/paused, else `null`; attaches `sessionId`); transcript row long-press **and**
  accessibility action "Add to notes" → transcript note (text = row raw text, `timestampMs` =
  row `start_ms`, `sequence`, `language`), Android toast "Added to notes".
- `android/src/components/TranscriptRow.tsx` / `TranscriptList.tsx` — optional
  `onAddNote(row)`; only finals (not partial/failed rows) get the action.
- `android/src/app/_layout.tsx` — start/stop `noteSync` with the signed-in uid (alongside
  `uploadService`; independent of server URL — notes sync needs only Firebase).
- `android/jest.setup.ts` — extend the Firestore mock (`getDocFromServer`, metadata).
- `firebase/firestore.rules` — notes contract + conflict rule above.
- `firebase/firestore.indexes.json` — drop the unused `notes (ownerId, timestampMs)` index
  only if no query uses it (the notes query is single-field `createdAt`; no composite needed).
- Docs: `docs/architecture.md` (notes data flow + sync/conflict state machine),
  `docs/security.md` (notes rules, deviceId is not a secret), `docs/event-runbook.md` (taking
  notes, what the sync chips mean, resolving conflicts), `docs/api.md` (Firestore note
  contract), `android/README.md` (notes, search, rules tests).

## Sync engine (`NoteSyncEngine`)
State per note (SQLite): `revision`, `synced_revision`, `remote_device`, `sync_state`.
`pending` ⇔ `sync_state='pending'`.

**Push loop** (`tick()`; serialized like `uploadService`; triggered by `notify()`, start,
network regained, app active, and a 30 s timer while pending rows exist):
- For each `pendingNotes(owner, now)` (oldest `updated_at` first, max 50/tick) that is not
  already in flight **at the same revision**: mark in flight `(id, revision)`, call
  `remote.push(note, deviceId)` with `baseRevision = synced_revision`, **without awaiting it
  inside the tick** (offline it never settles). Track the promise:
  - resolve → `updateNote` in a transaction-safe way: `synced_revision = max(synced_revision,
    pushedRevision)`, `remote_device = deviceId`; if `revision == pushedRevision` →
    `sync_state='synced'`, `last_error=null`, `attempts=0`.
  - reject `firestore/permission-denied` → `fetchFromServer` → apply
    `onRejected(local, server, deviceId)`:
    - server `null` → `failed`, `last_error='rejected'` (event missing/not owned/invalid);
    - `server.deviceId == deviceId && server.revision >= pushedRevision` → treat as acked;
    - otherwise → `conflict`, `remote_json = JSON(server)`.
    If the fetch itself fails → keep pending, backoff.
  - reject `invalid-argument` / `failed-precondition` → `failed` with the code.
  - any other rejection (`unavailable`, `deadline-exceeded`, unknown) → stay `pending`,
    `attempts+1`, `next_attempt_at = now + backoff` (reuse `lib/upload/backoff.ts`).
  - Late results for a revision older than the note's current revision must never overwrite
    newer local text or state (only advance `synced_revision`).
- On `start()` the in-flight set is empty, so pending notes are re-pushed; the idempotent rule
  (clause 3) and same-device rule (clause 2) make that safe.

**Pull** (`watch(eventId)` while an event's notes screen, a session screen, or search is open;
reference-counted; unsubscribe on last release):
- Ignore snapshots with `pending: true` (our own local echo).
- `mergeRemote(local, remote, myDevice)`:
  - `local == null` → insert as `synced` (`revision = synced_revision = remote.revision`,
    tombstones included so a later stale write cannot resurrect it).
  - `remote.revision <= local.synced_revision` → ignore.
  - `remote.deviceId == myDevice` → ack: `synced_revision = max(…, remote.revision)`,
    `remote_device = myDevice`; `synced` if `remote.revision >= local.revision`.
  - other device, local not pending and not in conflict → **apply** remote (text, speaker,
    deleted, timestamps…, `revision = synced_revision = remote.revision`).
  - other device, local pending → `conflict` with `remote_json` (never overwrite local text).
- **keepMine**: `revision = max(local.revision, remote.revision) + 1`,
  `synced_revision = remote.revision` (pushed with `baseRevision = remote.revision`),
  `remote_device = remote.deviceId`, `remote_json = null`, `pending` → push (rule clause 1).
- **useCloud**: copy remote fields, `revision = synced_revision = remote.revision`,
  `synced`, `remote_json = null`.
- Conflicts and failures are never auto-resolved and never drop local text.

Invariants to test: no lost local text in any path; a tombstone is never resurrected by a stale
remote or a late ack; a late resolve for revision N never marks revision N+1 synced; owner
isolation (another uid's notes are never pushed, listed, or searched); max 50 notes per tick.

## UI rules
- All writes are local first; the UI never waits on Firestore. Show `SyncChip` per note and a
  header summary ("3 notes waiting to sync" / "All notes synced" / "1 conflict needs you").
- Validation: text 1–5000 chars after trim (else inline error); speaker ≤ 100.
- Accessibility: every action has an `accessibilityLabel`; long-press actions also exposed
  via `accessibilityActions`; touch targets ≥ 48 dp; works with large fonts.
- Reuse theme components (`Screen`, `Card`, `Button`, `TextField`, `ChipSelect`, `Banner`,
  `EmptyState`). Copy is plain and short.

## Tests (must pass)
- `cd android && npx tsc --noEmit && npx eslint . && npx jest` — all green, including the 168
  existing tests.
- New jest coverage: model (validation, normalizeSearch on Kannada/Tamil/Hindi text,
  escapeLike, every `mergeRemote`/`onRejected` branch), repo (SQLite statement shapes via the
  existing pattern + memory twin semantics, search escaping, owner isolation), engine with
  fake remote + fake timers (offline never-settling push, ack, late ack after edit,
  permission-denied → conflict / acked / failed, transient backoff, restart re-push,
  keepMine/useCloud, tombstone not resurrected, 50 cap), Firestore adapter
  (`toFirestore` exact key set, `fromFirestore` rejects malformed docs, subscribe skips
  nothing but marks pending), UI (NoteRow chips, editor validation, quick note stamping).
- Rules tests (`firebase/rules-tests`, emulator): create valid/invalid (each field), other
  user denied, update clause 1/2/3 allowed, stale update from another device denied
  (lost-update prevention), revision not increasing denied, createdAt/ownerId/source change
  denied, tombstone requires empty text, non-deleted requires non-empty text, extra key
  denied, secret-like key denied; plus the existing-rules suite.

## Done when
- All tests above pass; `ruff`/server untouched; no new dependencies in `android/`.
- A note added in airplane mode appears immediately, survives an app restart, and its chip
  turns "Synced" when connectivity returns (engine test proves the flow with fakes).
- Firestore never receives partial-token writes; note writes only on user action.

## Report back
Files changed, test counts (jest + rules), anything you could not run (e.g. emulator in your
sandbox), and any deviation from this spec with the reason.
