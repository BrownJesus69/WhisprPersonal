# Event runbook - Phase 3 preflight; full workflow in Phase 9

## Prerequisites and access — completed in Phase 9

## Before the event — completed in Phase 9

## Network and device checks — completed in Phase 9

## Start and monitor recording — completed in Phase 9

## Troubleshooting and escalation — completed in Phase 9

## Recovery and rollback — completed in Phase 9

## Export and close the event — completed in Phase 9

## Retention and cleanup — completed in Phase 9


## Sign-in and local model preflight

While online, sign in with Firebase and get a grant using POST `/api/v1/auth/grant` with
the server key and a fresh Firebase ID token. Store it securely and switch the Bearer
header to the grant. Call `/api/v1/auth/check`: confirm `auth_method=grant` and check
`grant_expires_at` covers the event, including setup and wrap-up. Default TTL is 12 hours.
Create the session and fetch vocabulary before going offline because those operations
still use Firestore. Test a grant-authenticated reconnect after a laptop restart before
leaving connectivity. Preserve DATA_DIR (key and SQLite), cached models, and local LAN access.

When online, renew proactively if less than two hours remain, using a fresh Firebase ID
token. A grant cannot issue its own replacement. If it expires offline, reconnect to the
internet to renew sign-in. For theft, revoke the owned grant_id or rotate the file key
as an explicitly allowlisted owner; rotation invalidates every grant. Environment-managed
keys require external configuration rotation and restart. Firebase account revocation
alone does not invalidate an offline grant before expiry.
Local transcription needs no internet after models are loaded with WHISPER_LOCAL_FILES_ONLY=true.

Before leaving internet access, run `python -m app.cli download-models` (add --fallback
if accurate profile will be used), enable local-only mode and restart. Confirm /health
model.status=ready, queue.status=running, and overall status=ok. Check diagnostics for
safe errors and queue depth. Review the configured audio retention policy and free disk.

## Language test ? before each event

1. Record a short sample in each configured language (default Kannada, Tamil, Hindi,
   English), including event names from vocabulary. Use at least 15 seconds of speech
   across two or more chunks to exercise automatic locking.
2. Set expected_languages to the languages likely at the event. Check detected language,
   confidence, uncertain flags and language_locked in the stream. A strong out-of-set
   detection can indicate Kannada/Telugu confusion; review actual text and force the
   language when needed. Confidence does not guarantee correctness.
3. Switch the spoken language for at least two high confidence chunks. Confirm the first
   candidate is transcribed in that language and language_changed appears after the
   configured consecutive threshold. Test HTTP or stream set_language and reset to auto.
4. Upload a silence chunk: it must produce empty text with no_speech=true and no language
   lock change. Check overlap boundaries for missing/duplicated words; the last chunk must
   declare continues=false. Vocabulary replacements must not change the raw transcript.
5. Disconnect/reconnect the stream with after_seq set to the last persisted event. Confirm
   final results resume without duplicates. Test a duplicate upload before finalization.
6. Finalize with expected_chunk_count. Missing sequences must leave finalizing until late
   backlog arrives; use force only when accepting a partial result. Verify the final
   transcript and Firestore sync status. failed cloud sync retries without retranscribing.

## Phase 3 recovery

For queue_full, wait Retry-After and retry the same ID/content. For failed transcription,
inspect safe codes and retained audio privately; do not copy transcript/audio into logs.
On restart, in-flight processing rows recover as queued with attempts preserved. A model
error holds queued chunks without consuming attempts: fix the safe-code cause and restart.
Use delete only when no chunk is processing; retry session_busy. If firestore_deleted=false,
local deletion succeeded but an operator must follow up on cloud records. Default retention
keeps audio; delete_on_finalize removes audio only after local finalization. Neither policy
substitutes for encrypted backups and device access controls.

## Offline readiness (verified 2026-11-15 with all outbound traffic blocked)

1. While online: sign in on the phone and obtain an offline pass (`POST /api/v1/auth/grant`);
   confirm `grant_expires_at` (shown by `/api/v1/auth/check`) covers the whole event.
2. While online: open the event in the app once so the laptop caches its ownership
   (otherwise offline sessions are held local until the laptop is next online — still recorded
   and transcribed, just not synced).
3. Set `WHISPER_LOCAL_FILES_ONLY=true` once the model is downloaded.
4. Offline, the first new session may take ~10 s to start (Firestore timeout); later ones are
   immediate. Recording on the phone does not wait for this.
## Taking and finding notes (Phase 7)

Open an event and tap **Notes (n)**. Add a note, choose a speaker (or None), and save. Notes
appear after the phone saves them; airplane mode is supported. During an active recording,
use **Quick note → Add note** to attach the session and elapsed time. Paused recording keeps
its current time; notes taken after stopping have no recording offset. The event note editor
also stamps an active session for the same event. Long-press a finalized transcript row, or
use its accessibility **Add to notes** action, to copy its raw text and source time.

Use **Edit note** to change text/speaker. **Delete note** asks for confirmation and syncs a
deletion marker to other devices. AI-assisted notes are not configured in this phase.

The sync chips mean:

- **Saved on phone · syncing**: safely stored locally, waiting for cloud acknowledgement.
- **Synced**: the current local version has been acknowledged or pulled from the cloud.
- **Conflict**: another device changed this note; both copies are retained for your decision.
- **Not saved to cloud**: a permanent rejection needs attention; the phone copy is retained.
  Check the account/event and rules, then use **Retry cloud sync**.

For **Changed on another device**, read both texts. **Keep mine** publishes the phone copy
based on the cloud's latest revision; **Use cloud** explicitly takes the cloud copy (including
its deletion). Conflicts never resolve themselves. A deletion conflict stays visible until
you decide. The header counts pending deletions as well as visible notes. Leave the app open
or reopen it after connectivity returns to trigger retry; the laptop need not be connected.

The Library's **Search notes and transcripts** searches this account's saved phone data.
Enter two or more characters and pause briefly. Each section shows up to 50 newest matches;
note results open event notes, and transcript results open their recording session. Event
notes also have their own search box. Kannada, Tamil and Hindi combining marks are retained;
percent, underscore and backslash are searched as literal characters.
