# WhisprPersonal

Record multilingual events on an Android phone and transcribe them on your own laptop.
Audio queues on the phone when the laptop is unavailable. Raw transcripts remain separate
from optional AI cleanup, owner notes and reviewed briefs.

```text
Android phone <--> trusted LAN / Tailscale <--> Laptop FastAPI
     |                                          | SQLite + audio
     |                                          | faster-whisper GPU / CPU
     +----------> Firebase Auth / Firestore <----+
                                                |
                             optional Groq -> SambaNova -> local LLM
                             (eligible providers only; owner enables AI)
```

## Quick start

1. Complete the owner configuration in [setup](docs/setup.md), download models while online,
   and start the laptop with `server/start.bat` (Docker). Keep its data directory persistent.
2. Install the Android APK, sign in with Email/Password, and create/open an event.
3. Scan the laptop QR, enter its shared key separately, and test the connection. The QR
   contains only the server address. Check that the model is ready and the offline pass
   covers the event. Confirm consent, start a session and make a short test recording.

The APK needs a native build; Expo Go is insufficient. See [Android build instructions](android/README.md).

## Features

- Kannada, Tamil, Hindi and English, automatic language tracking and manual override.
- Screen-lock recording, overlapping chunks, durable upload retry, restart recovery,
  resumable live transcripts, and a searchable read-only transcript viewer.
- Event notes with timestamps, speakers, cloud sync and explicit conflict resolution.
- Optional conservative/polished cleanup; reviewed, edited and saved AI briefs.
- Offline Markdown/TXT phone exports with selected sessions, notes and an optional saved brief.
  Protected laptop transcript exports; PDF is not available yet.
- Speaker/name vocabulary, safe diagnostics sharing, and session deletion with queued
  laptop deletion when only the phone is available. Event notes and saved briefs are kept.

## Security and limitations

Protected laptop requests require a shared key plus Firebase identity or an offline pass;
missing auth configuration fails closed. The laptop independently checks session ownership.
Firestore rules restrict owner data. Provider keys stay on the laptop; phone credentials
use SecureStore. Cloud AI requires explicit event privacy permission and confirmed ownership.
Raw transcript text is never replaced by AI. [Security details](docs/security.md).

HTTP requires a trusted LAN or Tailscale; do not expose the server to the public internet.
Offline passes normally last 12 hours and cannot be renewed offline. Cloud AI/privacy
verification and cloud sync need internet. Recording quality, language accuracy, thermal
limits and Android background restrictions need rehearsal. Export shares sensitive owner
content with the chosen receiving app. One laptop process/worker is supported.

## Status

| State | Scope |
| --- | --- |
| Complete in code | Phases 1-10b: server, auth, recording, queue/recovery, live transcript, notes, optional AI, export/viewers, vocabulary, deletion, diagnostics, local translation UI, disabled integration stubs, operating documentation |
| Local translation | IndicTrans2 verified on this laptop; phone target picker, labelled Translation tab and optional export; LibreTranslate hi→en eligible but disabled until enabled; Groq emergency English audio fallback opt-in |
| Disabled future integrations | Calendar, Drive, Gmail, App Check, FCM, web search and Cloud Whisper; [owner prerequisites](docs/integrations.md) |
| Disabled pending keys/config | Groq and SambaNova each require both a key and an account-accessible model; local LLM requires explicit URL/model; Google Sign-In stays behind its feature flag |
| Owner must configure | Enable Email/Password in Firebase console; deploy Firestore rules and indexes; set server shared secret and Firebase service-account path privately; choose provider keys/models if wanted; Tailscale is optional |
| Not yet verified on a device | Full Phase 9 APK flows, native sharing, screen-lock endurance, failure drills, export readability and deletion recovery on real hardware |
| Not available | PDF export and future integrations such as calendar/Drive/Gmail/App Check enforcement |

A prior local APK build is documented in [android/README.md](android/README.md); it is not
proof of Phase 9 device behavior. Run [automated checks and device matrix](docs/test-plan.md)
and the [event rehearsal checklist](docs/event-runbook.md) before relying on this at an event.
See [API](docs/api.md) and [architecture](docs/architecture.md). Follow AGENTS.md when contributing.
