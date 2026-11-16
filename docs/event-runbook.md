# Event runbook

Use this with the owner account, charged phone and the configured laptop. Rehearse on the
actual venue network and devices; code tests do not establish recording reliability.

## Sign-in and local model preflight

While online, sign in with Firebase and get a grant using POST `/api/v1/auth/grant` with
the server key and a fresh Firebase ID token. Store it securely and switch the Bearer
header to the grant. Call `/api/v1/auth/check`: confirm `auth_method=grant` and check
`grant_expires_at` covers the event, including setup and wrap-up. Default TTL is 12 hours.
Open/create the event and fetch vocabulary before going offline so ownership and metadata
are cached. Unverified offline ownership defers cloud writes without stopping local capture. Test a grant-authenticated reconnect after a laptop restart before
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

## Language test before each event

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

## Laptop queue recovery

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

**Search notes** (History > Events, notes and briefs) searches this account's saved phone data.
Enter two or more characters and pause briefly. Each section shows up to 50 newest matches;
note results open event notes, and transcript results open the read-only viewer at the matching part. Event
notes also have their own search box. Kannada, Tamil and Hindi combining marks are retained;
percent, underscore and backslash are searched as literal characters.

## Cleanup and brief review on the phone (Phase 8b)

After a recording session is **finalized**, choose Conservative or Polished cleanup in
Settings, open the session, and tap **Clean up**. Its queued/running status appears here;
completion reports cleaned parts and parts kept as raw. Open **Polished** to review the
labelled AI-cleaned text. Parts without accepted cleanup show the original text and
**Not cleaned**. **Raw** always shows the original transcript. Cleanup is explicit and
never runs during recording.

For an event brief:

1. Open the event and tap **Briefs**. Finalized local sessions are selected by default;
   choose at most 20 and choose Summary, Action items, Decisions, Follow-ups, or Full brief.
2. **Include my notes** sends the newest 200 non-deleted event notes. Turn it off to use
   only speech. **Use cleaned text where available** is off by default.
3. If any selected transcript is partial or its completeness is unknown, review the warning
   and explicitly check **Generate from incomplete transcript** before generating.
4. Tap **Generate**. You can leave the screen while the laptop works. The app resumes
   polling pending jobs after restart; it never automatically resubmits paid work.
5. Review the draft, its provider/model label, and any incomplete/unstructured warning.
   Edit the text, then **Save**, or **Discard** the draft. Draft text and edits stay on the
   phone across restarts. Generated output is retained separately from the saved edit.
6. Open an entry under **Saved briefs** to read it. Saving queues Firestore sync without
   waiting for internet. Cached briefs and the phone's saved copies remain readable offline.
   A rejected cloud write leaves the phone copy available; use **Retry cloud save** after
   resolving account/rules/connectivity issues.

**Cloud AI unavailable; raw transcript preserved.** means no cloud or local provider is
currently eligible. It is normal with the default laptop configuration. Recording, raw
transcription and notes still work. Configure providers on the laptop, then refresh provider
status. For a `local_only` event without an available local model, the app says **Cloud AI
is off for this event**. Changing this requires an intentional event privacy decision.
**The laptop restarted; request it again.** means the server interrupted a pending AI job;
review the session and submit a new request yourself.


## Before leaving for the venue

- Charge phone, laptop and power banks. Bring laptop supply, USB cable, adapters and a
  tested external microphone if used. Keep the laptop ventilated; avoid direct sun and bags.
- Check free phone and laptop disk in Diagnostics; rehearse a recording long enough to
  estimate storage for the event plus margin. Master audio remains until session deletion.
- Pre-download models while online and restart in local-files-only mode. Run the language
  tests above including mixed speech. Keep the desired model loaded and power connected.
- Disable restrictive battery saver/optimization for recording as appropriate for this
  phone. Check microphone and recording notification permissions. Lock the screen during
  rehearsal and confirm duration, audio chunks and speech keep advancing after unlock.
- Decide retention, privacy mode and whether cloud AI is permitted before recording.
  Obtain informed consent from participants, including how audio and transcripts are kept.

## At the venue: connection and vocabulary

Use a trusted Wi-Fi router or a rehearsed hotspot; check client isolation does not block
phone-to-laptop access. Avoid changing networks during capture. Keep a Tailscale fallback
only if both devices and their permissions have already been tested. Start `server/start.bat`,
scan its QR in Connect laptop, enter the key separately and test the connection. Check
Diagnostics model ready, queue running, provider status, free disk and upload counts.

Open the event > Vocabulary. Load the laptop list, tap **Add event speakers**, add names,
places and jargon (up to 200 terms, 64 characters each), then **Save vocabulary**. Terms
help Whisper spell future chunks; existing raw transcript text is unchanged. Reload to
verify the saved list, then record the names and inspect the transcript.

Renew/check the 12-hour offline pass while online; expiry must cover setup through export.
Restart the laptop with internet disabled and confirm connection using that pass. Protect
DATA_DIR, which contains its signing key. Load the event and saved briefs into phone cache.

## Live recording and failure drills

Confirm consent, start the session and speak a dated test phrase. Check elapsed time,
level meter, new chunks, queue progress and transcript. Use a short manual language override
if auto detection is wrong, then return to Auto when appropriate. Do not delete or reinstall
the app during an event. Stop and finalize deliberately; finalizing waits for missing chunks.

| Drill | Expected behavior and recovery |
| --- | --- |
| Laptop Wi-Fi drop | Phone keeps saving chunks. Restore the same route; upload retries and transcript reconnect resumes without duplicates |
| Laptop restart | Keep DATA_DIR/model cache. Processing work requeues; wait for ready, reconnect with unexpired pass and check backlog drains |
| App killed | Continuous capture may stop. Reopen, inspect recovered session/master audio, resume if offered or finish and start a new session; do not claim the missing interval was recorded |
| Screen locked | Recording notification remains; unlock after several chunks and check elapsed time and transcript/audio continuity |
| Battery saver | Confirm behavior on this phone; if capture stops, disable restrictions, recover saved audio and use external power |
| Server queue full | Saved audio remains on phone; wait for queue capacity/Retry-After, avoid repeated manual requests and confirm automatic retry |
| Low connectivity / WebSocket loss | Local audio and notes remain; HTTP catch-up and stream replay reconcile final text. Check actual gaps before exporting |
| Expired pass offline | Keep recording locally; reconnect internet and renew sign-in before retrying laptop operations |
| Low storage / thermal shutdown | Stop safely, preserve existing files and make space using reviewed retention/deletion; cool devices and start a new test before resuming |

If recovery is uncertain, stop new work and preserve the phone data and laptop DATA_DIR.
Inspect safe error codes in Diagnostics and record the affected session/time privately.
Use a new session after recovery rather than overwriting evidence. Do not rotate keys or
reinstall as a troubleshooting shortcut. Refer unresolved configuration/device issues to
the owner with a diagnostics share, excluding audio/transcript excerpts unless authorized.

## Export and close

1. Stop each session. Leave the phone/laptop connected until upload and transcription finish.
   Read the transcript viewer's status, missing/failed parts and language timeline. Search
   names/numbers, listen to questionable source audio, and resolve note conflicts.
2. Optionally clean up and generate/review/save a brief using the existing sections above.
   Cloud AI needs live privacy verification; export and reading cached data work offline.
3. Event > **Export**. Select sessions, Markdown or TXT, and Raw (default) or Cleaned.
   Notes default on. Choose a saved brief explicitly to include its reviewed `finalText`.
   PDF is disabled as **not available yet**. Tap **Export**, choose a trusted destination,
   then open the received file and check beginning/end, Unicode, gaps and chosen sections.
4. For a laptop-only transcript, use authenticated `POST /api/v1/export` with event_id,
   1-20 owned session_ids, format md/txt, optional title and text raw/polished. Save the
   attachment using a trusted authenticated client; see [API](api.md). The laptop has no
   notes or briefs. Do not put keys/tokens into URLs or shared command history.
5. Keep a reviewed export in the agreed protected location. Tell participants about any
   incomplete intervals; `[part not transcribed]` is an explicit gap, not invented speech.

## Retention, deletion and privacy

Before sharing, check the receiving app and audience. Exports contain owner text even though
they exclude connection credentials and device ids. Cache export files older than 24 hours
are removed on the next export, not on a continuous timer; copies in receiving apps remain.
Use phone lock and disk encryption on both devices. Do not export participant data without consent.

To remove a session, stop recording, open its session screen and choose **Delete session**.
Confirm irreversible removal of audio/transcript from phone and laptop. Event notes and saved
briefs are retained separately and may still contain copied speech. A busy laptop part must
finish first. If unreachable, choose **Delete on this phone only** only after reading the
warning: the laptop copy remains until the upload service retries its queued deletion.
Reconnect to the same laptop/account, open the app and check Diagnostics pending server
deletes reaches zero. A laptop 404 is treated as already deleted. Follow up separately on
any Firestore records if the laptop reports cloud deletion failure. Delete notes/brief copies
and receiving-app exports according to the agreed retention policy; session deletion is not
secure media erasure or an all-device data purge.

## Final rehearsal checklist (print this page)

Event: __________________ Date/time: ______________ Owner: __________________

- [ ] Consent, retention and event privacy mode agreed; attendees informed.
- [ ] Phone/laptop/power banks charged; supplies, cable and ventilation ready.
- [ ] Storage margin measured for event duration; no restrictive battery saver.
- [ ] Installed APK tested; microphone and recording notification permissions granted.
- [ ] Models downloaded; local-files-only restart succeeds; correct model ready.
- [ ] LAN/hotspot connected, no client isolation; Tailscale fallback tested if used.
- [ ] Shared key entered privately; offline pass covers event plus wrap-up.
- [ ] Laptop restart without internet preserves pass, ownership cache and queued work.
- [ ] Vocabulary loaded, event speakers added, saved and checked with real speech.
- [ ] Kannada, Tamil, Hindi, English and mixed tests read; silence and seams reviewed.
- [ ] Locked-screen recording verified over several chunks and after unlock.
- [ ] Wi-Fi drop/reconnect, app kill/recovery, laptop restart and queue-full drills passed.
- [ ] Notes created offline, timestamped, synced; conflict handling rehearsed.
- [ ] Finalization complete or known gaps accepted; viewer search/sequence navigation checked.
- [ ] Cleanup/brief reviewed if enabled; raw transcript unchanged.
- [ ] Markdown and TXT exports opened in receiving app; PDF visibly unavailable.
- [ ] Safe diagnostics share inspected; no participant text or credentials.
- [ ] Disposable-session deletion tested; offline pending retry reaches zero; notes kept.
- [ ] Protected export destination and retention/deletion follow-up assigned.

Decision: [ ] Ready  [ ] Defer; unresolved issue: ______________________________

## After the event: translation

1. Wait for the session to show finalized. Translate is hidden during recording and finalizing.
2. Check Settings → Translation (on your laptop), or refresh Diagnostics for engine directions
   (`ready_on_disk` / `loaded`) and LibreTranslate pair enabled/eligible/available states.
3. Open the session or saved transcript, choose English, Kannada, Tamil or Hindi, then Translate.
   The source language comes from each chunk. AI-polish is optional and off by default; only
   providers permitted by this event's privacy mode can be used.
4. Open Translation. Each result shows engine, model/revision, source→target and local date/time.
   **AI-polished (provider · model)** is an additional block below dedicated engine text.
   **Emergency English translation from audio (Groq) — no transcript was produced** identifies
   the opt-in fallback, whose source is `und`; do not treat it as a recovered raw transcript.
5. Tap Raw at any time to inspect original speech. **Not translated** means the original text
   is being shown for that part. If the banner says **Translation unavailable; showing the
   original transcript.**, continue using Raw. Check laptop status and model availability,
   reconnect, then explicitly request again if the job failed or was interrupted. Never
   download models during an event. App restart resumes polling existing active jobs.
6. For sharing, select **Include translation (target)** in Export (default off). The saved
   translation section follows the transcript, with every line labelled. Review all output.

Future integrations in Settings remain disabled. They need separate owner setup and consent;
their unconfigured state does not interfere with the event. See [integrations](integrations.md).
