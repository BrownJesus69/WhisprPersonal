# Phase 8b — App: Polished transcript, cleanup, brief generator and review

**Working directory:** `E:\Whispr` (app code in `E:\Whispr\android`). Read `E:\Whispr\AGENTS.md`
(wins) and `E:\Whispr\android\AGENTS.md`. **No network**; read APIs in `node_modules`; no new
dependencies. Phases 4–8a are committed. The **server contract is fixed** and is the source of
truth: `server/app/routers/ai.py`, `server/app/schemas/ai.py`, `server/app/schemas/health.py`,
`server/app/core/errors.py`, `docs/api.md` — read them, do not change server code. Do not touch
`secrets/`, `android/app/google-services.json`, any `.env`, `.gitignore`, `AGENTS.md`. Do not run
`git commit`. Put any scratch/test temp output under `android/` ignored paths or your own temp,
**never in `E:\Whispr\output\`**.

## Goal
On the phone: (1) request **transcript cleanup** for a finalized session and view it in the
**Polished** tab (raw always kept and shown separately); (2) a **Brief generator** per event,
available only after a session is finalized: choose type, see which provider produced it, edit
before saving, save to Firestore `events/{eventId}/briefs/{briefId}`, and view saved briefs. With
no provider configured (the current state) everything shows a calm
"Cloud AI unavailable; raw transcript preserved." and nothing else breaks.

## Server contract (implemented; quote of what matters)
All calls use `ServerClient` with the server key + bearer (Firebase token or offline pass) exactly
as `uploadService.start` builds it (`createTokenManager(url)`, `credentials.getServerKey`,
same-account guard). Factor that construction into `android/src/lib/server/authedClient.ts`
(`authedClient(owner): ServerClient | null` when no server URL) and use it for AI calls (you may
switch `uploadService` to it only if its tests stay unchanged and green).
- `POST /api/v1/notes/cleanup` `{event_id, session_ids[1..20], level: 'conservative'|'polished'}`
  → 202 `{job_id, status}`.
- `POST /api/v1/briefs` `{event_id, session_ids[1..20], brief_type:
  'summary'|'action_items'|'decisions'|'follow_ups'|'full', allow_incomplete, use_polished,
  notes: [{text ≤5000, timestamp_ms|null, speaker|null}] (≤200)}` → 202 `{job_id, status}`.
- `GET /api/v1/ai/jobs/{job_id}` → `{job_id, kind, status: queued|running|done|failed|interrupted,
  provider, model, error_code, result}`. Cleanup result `{accepted, rejected, skipped, provider,
  model}`; brief result `{brief_type, generated_text, structured_brief: Record<string,
  string[]|string>|null, brief_warning: 'unstructured_output'|null, provider, model, incomplete,
  source: {session_ids, chunk_count, used_polished}}`.
- `GET /api/v1/sessions/{id}/polished` → `{session_id, chunks: [{sequence, polished_text|null,
  polished_level|null, polish_error|null}]}`.
- `GET /api/v1/ai/status` → `{providers: {groq|sambanova|local_llm: {status:
  not_configured|ready|degraded|circuit_open|auth_failed, model|null, last_error_kind|null}},
  cloud_available, local_available}`. `/health` `providers.*` now has the same statuses plus
  `configured`.
- Errors (envelope `{error:{code,message,request_id}}`): `provider_unavailable` 503 (message
  "Cloud AI unavailable; raw transcript preserved."), `cloud_ai_disabled_for_event` 403,
  `privacy_mode_unknown` 503, `transcript_incomplete` 409, `transcript_too_long` 422,
  `rate_limited` 429 (`Retry-After`), `queue_full` 503, `not_found` 404. Job `error_code` may
  also be `job_timeout`, `ai_output_invalid`, `provider_unavailable`, `transcript_too_long`.
  Map every code to a short, plain, user-facing sentence in one place (`lib/ai/messages.ts`).
- Server session ids **are** the local `recording_sessions.id` values.

## Local storage — SQLite migration 4 (`lib/db/database.ts`, repos + memory twin)
```sql
ALTER TABLE transcript_chunks ADD COLUMN polished_text TEXT;
ALTER TABLE transcript_chunks ADD COLUMN polished_level TEXT;
ALTER TABLE transcript_chunks ADD COLUMN polish_error TEXT;
CREATE TABLE ai_jobs (
  job_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cleanup','brief')), session_ids TEXT NOT NULL,
  status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE brief_drafts (
  id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, event_id TEXT NOT NULL, job_id TEXT,
  brief_type TEXT NOT NULL, provider TEXT, model TEXT, generated_text TEXT NOT NULL,
  edited_text TEXT NOT NULL, structured_json TEXT, warning TEXT, incomplete INTEGER NOT NULL,
  session_ids TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','saved')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
PRAGMA user_version = 4;
```
**Important:** the existing transcript upsert (`TRANSCRIPT_UPSERT`) must not clobber polished
columns, and a raw-text revision (seam re-stitch) of a chunk must clear that chunk's polished
columns (they no longer match). Raw columns are never written by polished code.

## Modules
- `lib/ai/api.ts` — typed wrappers + runtime validation of responses (reject malformed →
  `ServerError(0,'bad_response')`).
- `lib/ai/jobs.ts` — `AIJobRunner` (RN-free, injected client/repo/clock): persists submitted job
  ids (`ai_jobs`), polls `GET /ai/jobs/{id}` at 2 s → backoff to 10 s, stops on terminal
  status, resumes polling of non-terminal jobs after app restart; on cleanup `done` fetches
  `/sessions/{id}/polished` for each session and stores polished columns; on brief `done`
  creates a `brief_drafts` row (`edited_text = generated_text`). Network/5xx while polling →
  keep polling with backoff (job is durable on the laptop); 404 → mark `failed/not_found`;
  `interrupted` → show "The laptop restarted; request it again." Singleton wrapper started with
  the signed-in uid in `src/app/_layout.tsx` (like `noteSync`).
- `lib/ai/briefs.ts` — Firestore brief save/list: `saveBrief(owner, draft)` → `setDoc` with a
  device-generated id, **not awaited** (offline-safe `background()` pattern from
  `lib/firebase/events.ts`), marks the draft `saved`; `subscribeBriefs(eventId)` →
  `onSnapshot(query(collection(db,'events',eventId,'briefs'), orderBy('createdAt','desc'),
  limit(50)))`.
- Firestore brief contract (exact keys): `ownerId`, `type` (5 types), `status: 'saved'`,
  `provider: 'groq'|'sambanova'|'local_llm'|'none'`, `model: string ≤ 200 | null`,
  `generatedText: string ≤ 100000` (the model output), `finalText: string 1..100000` (what the
  owner saved), `edited: bool`, `structuredBrief: map | null`, `incomplete: bool`,
  `sessionIds: list ≤ 20`, `createdAt: timestamp` (client), `updatedAt == request.time`.
  Update `firebase/firestore.rules` briefs match accordingly (owner-only, contract on
  create/update, `ownerId`/`createdAt` immutable) and add `firebase/rules-tests/test/briefs.test.ts`
  (run instructions in `firebase/rules-tests/README.md`; if your sandbox cannot bind the
  emulator port, say so).

## UI
- **Polished tab** (`TranscriptTabs` becomes a real tab switch; session screen holds the
  selection): Raw = unchanged current list. Polished = each final row's `polished_text`, or the
  raw text with a muted "Not cleaned" label when absent/rejected. Header label: "AI-cleaned text.
  Your raw transcript is unchanged." Polished is never shown in place of Raw without the label.
- **Clean up** button on the session screen only when the local session is `finalized`. Level =
  `settings.cleanupLevel` (`none` → button explains "Choose a cleanup level in Settings").
  Disabled with the reason when: no server URL; `ai/status` says neither cloud nor local
  available; event `privacyMode === 'local_only'` and no local LLM ("Cloud AI is off for this
  event"). Shows job progress and the result counts ("12 parts cleaned, 2 kept as raw").
- **Brief screen** `src/app/events/[eventId]/brief.tsx` (+ "Briefs" button on the event screen,
  route registered in `_layout.tsx`): session picker (finalized local sessions of this event,
  all selected by default); type chips (Summary, Action items, Decisions, Follow-ups, Full brief);
  "Include my notes" toggle (default on; sends this event's non-deleted local notes, newest 200,
  `text`, `timestamp_ms`, `speaker`); "Use cleaned text where available" toggle (default off);
  if any selected session is not `transcript_status complete` (from the server finalize
  outcome stored locally, or `session_finalized` event `transcript_status`), show a warning and
  an explicit "Generate from incomplete transcript" checkbox → `allow_incomplete`.
  Provider status line from `/ai/status`. Generate → job → draft editor: multiline `TextInput`
  with the text, a badge "Generated by <Groq|SambaNova|Local model> · <model>", an
  "AI-generated — check it against the transcript" notice, `incomplete`/`unstructured_output`
  warnings, buttons Save / Discard. Saved briefs list (Firestore, cache-backed so it works
  offline) with a read-only viewer. Drafts survive app restart.
- `HealthPanel` / types: show provider status words (Not configured / Ready / Degraded /
  Paused after errors / Key rejected) instead of only configured Yes/No.
- Generated content is always visually separated from raw transcript (own screen/section,
  label, never merged into transcript rows or notes).

## Tests (jest-expo, offline) — all must pass with the existing 266
`tsc --noEmit`, `eslint .`, `jest`: api response validation; message mapping for every error
code; job runner (submit persists, polling backoff, restart resume, terminal states, cleanup
`done` stores polished without touching raw, brief `done` creates draft, 404/interrupted);
migration 4 + repo (upsert keeps polished, raw revision clears polished, memory twin parity);
brief save → exact Firestore key set, not awaited, draft marked saved; UI (Polished tab labels
and fallback, Clean up disabled reasons, brief type chips, incomplete checkbox gating, editor
save). Rules tests for briefs pass (architect will run if you cannot).

## Docs
`docs/event-runbook.md` (cleanup and brief steps, what "Cloud AI unavailable" means),
`docs/architecture.md` (app AI flow), `android/README.md` (enable providers on the laptop; the
app holds no provider keys).

## Done when
All checks green; with no provider configured the app shows the unavailable state everywhere and
the transcript/notes flows are unchanged. Report files changed, test counts, deviations.
