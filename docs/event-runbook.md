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

Accepted limitation (2026-11-15): events require internet access for sign-in. Confirm the
hotspot/Wi-Fi has internet and sign in on the phone within the hour before recording.
Firebase ID tokens expire after one hour; laptop signing certificates are memory-only.
Keep internet available for token refresh. Local transcription needs no internet after
models are loaded with WHISPER_LOCAL_FILES_ONLY=true.

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
