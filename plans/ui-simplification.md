# UI simplification (1.0.3)

**Goal:** make the app usable with as few decisions and taps as possible, without removing
capability. The owner asked for "the entire create Event and the Settings and everything" to be
simplified heavily, and approved the design below on 2026-11-16.

Implemented directly by the architect, not delegated: the work was design judgment across
screens that had just been read in full, so a Codex round-trip would have cost more than it saved.

## Design

- **Create event:** name plus one language choice (Auto/Kannada/Tamil/Hindi/English), which sets
  both `languageMode` and `languages`. Location, description and comma-separated speakers sit in
  a closed "More details". Typed start/end fields, agenda and the per-event privacy choice are
  gone; privacy comes from the Settings default.
- **Event:** large "Start recording", then Notes · Brief · Export in one row, then recordings.
  Vocabulary and the event details are under "More".
- **Connect laptop:** address (or Scan QR), server key, one "Connect" button that runs health,
  auth check, offline pass and save in sequence. Health details are in a closed section.
- **Settings:** Laptop, Account, Phone storage, then everything else in a closed "Advanced".
- **Tabs:** Events and Settings. The Library tab is removed; all events were already listed on
  Events, and "Search notes" is a button there.
- **Recording:** the lock-screen notice shows only before starting; language override, cleanup,
  translation and delete are under "More options".

## Also fixed

`getEvent` falls back to the phone cache when the server read fails. A just-created event is
only in the cache until its background write lands, and the rules deny reads of documents the
server does not have, which showed "Could not load this event."

## Done when

- `npx tsc --noEmit`, `npx eslint src`, and `npx jest` all pass.
- APK 1.0.3 / versionCode 13 is built with Google sign-in on, and replaces v1.0.2 as the only
  GitHub release.
