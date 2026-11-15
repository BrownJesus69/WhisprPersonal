# Future integrations

All integrations below are disabled by default. The laptop exposes static, credential-free
status in `/health` and authenticated `/api/v1/diagnostics`: `enabled: false`, `status:
"disabled"` (flag off) or `"not_configured"` (flag on), and a documentation link. The flags
alone cannot activate these stubs. Settings uses these statuses when connected and shows
"Not configured" offline. Nothing here calls an external API or blocks recording or ASR.
Identifiers and credentials belong on the laptop, never in the phone bundle or Firestore.

Local translation is a separate working feature; see [translation](translation.md). There
is no Google Cloud Translation integration or translation key.

## Calendar

Would create or list calendar event stubs. Flag: `FEATURE_CALENDAR=false`.
Placeholder: `CALENDAR_ACCOUNT=`. The owner must later choose an account, authorize calendar
access, and provide an approved credential flow and consent. Event titles, times, speakers,
and attendee details can leave the laptop only after explicit owner approval.
`CalendarProvider` and `DisabledCalendar` currently return status without side effects.

## Drive

Would upload a chosen export. Flag: `FEATURE_DRIVE=false`. Placeholder: `DRIVE_FOLDER_ID=`.
The owner must supply an account, consent, credentials, and destination folder; review folder
sharing before enabling anything. Exports can contain sensitive transcripts and notes.
`DriveProvider` / `DisabledDrive.upload_export` never upload a file.

## Gmail

Would send a reviewed brief. Flag: `FEATURE_GMAIL=false`. Placeholder: `GMAIL_ACCOUNT=`.
The owner must provide account authorization, consent, credentials, intended recipients and
an explicit send confirmation. Briefs may expose private event information.
`GmailProvider` / `DisabledGmail.send_brief` never send mail.

## App Check

Would verify app attestation tokens. Flag: `FEATURE_APP_CHECK=false`.
Placeholder: `APP_CHECK_PROJECT_ID=`. The owner must register an app/provider, configure its
project and credentials privately, and supply a verifier implementing `AppCheckVerifier`.
The default `DisabledAppCheck` has `configured=false`, including when the flag is true.
Enforcement requires BOTH the flag and an explicitly configured verifier on
`app.state.app_check_verifier`; enabling the flag alone never blocks MVP requests.
Shared-key and identity authentication continue to fail closed independently. Invalid
attestation from a configured verifier returns the standard safe auth error. Attestation
tokens must not be logged, synced, or exported.

## FCM

Would send consented push notifications. Flag: `FEATURE_FCM=false`.
Placeholder: `FCM_PROJECT_ID=`. The owner must provide project authorization, credentials,
registered device tokens and notification consent. Avoid transcript content in notifications,
which may appear on lock screens. `FCMProvider` / `DisabledFCM.send_push` never send a push.

## Web search

Would enrich notes with external sources. Flag: `FEATURE_WEB_SEARCH=false`.
Placeholder: `WEB_SEARCH_API_KEY=`. The owner must select a provider, supply its account/key
and consent, and define which queries may leave the laptop. Queries can reveal event topics;
external text must be treated as untrusted input. `WebSearchProvider` /
`DisabledWebSearch.enrich` never issue a search.

## Cloud Whisper

Would provide a separately configured cloud ASR integration. Flag: `FEATURE_CLOUD_WHISPER=false`.
Placeholders: `CLOUD_WHISPER_API_KEY=`, `CLOUD_WHISPER_MODEL=`. The owner must choose a provider,
account, accessible model and consent before a future implementation can send audio.
Status: not configured; emergency English-only audio translation via Groq is available
separately when enabled. `CloudWhisperProvider` / `DisabledCloudWhisper.transcribe` never send
audio. The existing opt-in Groq fallback remains governed by its own settings and per-event
cloud privacy consent; this flag does not activate it.
