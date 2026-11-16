# UX-1: Design foundation, navigation, and the Speak journey

Working directory: `E:\Whispr`. The app is in `android/` (Expo SDK 58, React Native 0.8x,
TypeScript strict, expo-router 58, zustand, @tanstack/react-query, expo-sqlite). Run all commands
from `E:\Whispr\android`. Read `E:\Whispr\AGENTS.md` first and follow it.

This is phase 1 of a redesign, driven by the owner's product brief: *"I tap, I speak, and my words
are there."* Later phases (not this task) cover setup and onboarding, the full History and
Settings polish, the Android voice keyboard, and the accessibility and localization pass.

## Owner decisions (fixed; do not revisit)

- **Sign-in stays.** Google or email sign-in is still required. Do not remove the auth screens.
- **Transcripts are kept by default** on the phone, as today.
- **Recognition happens on the owner's computer** (the laptop server). There is no on-phone
  recognition. The UI must say "On your computer" or "Computer not connected", and must never
  claim "On this phone" processing.
- The voice keyboard is a later phase. Do not add IME code.

## Goal

A returning, connected user opens the app on **Speak**. They tap one big button, speak, and tap
the same button to stop. Their words then appear as editable text, with **Copy** as the dominant
action. Everything else stays out of the way.

## Dependencies (already installed by the architect before this task)

`expo-clipboard`, `@expo-google-fonts/manrope`, `@expo-google-fonts/noto-sans-kannada`,
`@expo-google-fonts/noto-sans-tamil`, `@expo-google-fonts/noto-sans-devanagari`. Check
`package.json`. If any is missing, STOP and report it; do not install anything (no network).

## 1. Design tokens (`src/theme/`)

- Replace `colors.ts` with the brief's palette, keeping every existing key name so all current
  screens still compile, and adding the new ones:
  - light: background `#F7F6F2`, surface `#FFFFFF`, subtle `#EFEDE7`, elevated `#FFFFFF`,
    text `#222521`, muted `#59615B`, primary (accent) `#17675A`, onPrimary `#FFFFFF`,
    border `#DAD7CF`, record `#B3261E`, onRecord `#FFFFFF`, danger `#B3261E`,
    warning `#7A5300`, success `#1E6B3A`, info `#2B5A8A`.
  - dark: background `#141816`, surface `#1C221E`, subtle `#202722`, elevated `#252D27`,
    text `#F1F3EE`, muted `#B4BDB4`, primary `#9DD8BE`, onPrimary `#102B20`,
    border `#33403A`, record `#FFB4AB`, onRecord `#690005`, danger `#FFB4AB`,
    warning `#F2C46D`, success `#9DD8A8`, info `#A8C8F0`.
- Add `src/theme/contrast.ts` with a WCAG relative-luminance `contrastRatio(a, b)` function. Add
  a test asserting text/background, text/surface, muted/background, onPrimary/primary and
  onRecord/record are at least 4.5:1 in both themes. If one fails, adjust that token minimally
  and say so in your final message.
- Spacing: keep the existing keys and add a 4 dp scale `space(n) = n * 4`. Screen gutter: 20.
- Typography (`typography.ts`): body 16/24, transcript 19/30, title 26/32, heading 20/28,
  label 14/20, caption 13/18. Latin UI text uses Manrope (400/600/700). Indic text uses
  bundled Noto Sans Kannada, Tamil or Devanagari. Add `src/theme/fonts.ts` with
  `fontFor(text, weight)`, which picks the Noto family when the text contains Kannada
  (U+0C80–U+0CFF), Tamil (U+0B80–U+0BFF) or Devanagari (U+0900–U+097F), and Manrope otherwise.
  Never set `letterSpacing` on Indic text. Use generous line height for Indic scripts (×1.5).
- Load fonts in `src/app/_layout.tsx` with `expo-font`'s `useFonts`. Keep the splash screen
  until the fonts load or fail; on failure, render with system fonts. Never block forever.
- Appearance: add `appearance: 'system' | 'light' | 'dark'` (default `'system'`) to
  `src/state/settingsStore.ts`, with normalization and tests, and apply it in the root layout.

## 2. Strings (`src/i18n/`)

Create `src/i18n/en.ts` (a flat object of English strings) and `src/i18n/index.ts` exporting
`t(key, params?)` with `{name}` interpolation. Every new user-facing string in this task goes
through `t()`. Do not build sentences by concatenating fragments. Existing screens you do not
touch can keep their literals.

## 3. Reusable components (`src/components/ui/`, new or extended)

- `BottomSheet`: built on RN `Modal` (slide animation, about 200 ms), with a scrim. Android Back
  and a tap on the scrim close it. It has a title, a drag-handle visual, and safe-area padding.
- `MicButton`: one 88 dp round control that **stays in the same position** across states
  `ready` → `listening` → `processing` → `complete`.
  - ready: accent fill, microphone glyph, label "Start speaking".
  - listening: record colour, square stop glyph, label "Stop".
  - processing: disabled, with `ActivityIndicator`.
  - complete: accent, label "Speak again".
  - It has an accessibility label and state, a 48 dp minimum hit area, and ~150 ms press
    feedback.
- `LevelBars`: 24 thin bars from a rolling buffer of the **real** dBFS values the recording
  store already publishes (`useRecordingStore().dbfs`). It is flat when not recording, has no
  idle animation, and respects `AccessibilityInfo.isReduceMotionEnabled` (then show a single
  static level).
- `StatusLabel`: a small dot plus text, never colour alone. The text is one of
  "Connected to your computer", "Computer not connected", "Connecting…" or "Reconnecting…",
  from `useConnectionStore` status and the live stream status. Tapping it when not connected
  opens `/connect`.
- `LanguageChip` plus `LanguageSheet`. The chip shows "Auto-detect ▾" or "Kannada ▾". The
  sheet has:
  - a search field;
  - "Recent" (the last 3 choices);
  - all languages with native names: "Kannada — ಕನ್ನಡ", "Tamil — தமிழ்", "Hindi — हिन्दी",
    "English";
  - "Auto-detect" with the line "Useful when the language is unknown. Choose a language if
    recognition is unreliable."
  Only list `LANGUAGES` from `src/types/models.ts` (what the server supports). Persist the choice
  as `settings.defaultLanguageMode` and keep a `recentLanguages` list in the settings store.
  The choice takes at most two taps from Speak.
- `InlineNotice`: a calm, full-width notice for problems. It has a title line, a "your work is
  safe / not safe" line, and one action button. Use it for every error state below. No red
  borders around normal info.

## 4. Navigation

- Tabs: **Speak** (`src/app/(app)/index.tsx`, the landing screen), **History**
  (`src/app/(app)/history.tsx`), **Settings** (existing). Use simple text glyph icons as now.
  Tab headers are hidden on Speak; it has its own compact header.
- Move the current events list to a stack route `src/app/events/index.tsx` titled "Events".
  It reuses `EventList`, and every existing event route keeps working. History links to it
  with a quiet row: "Events, notes and briefs".
- Preserve tab state when switching tabs. Leaving Speak while recording must **not** stop the
  recording. The recording store is global, so Speak re-attaches when shown.

## 5. Speak screen (`src/app/(app)/index.tsx` plus `src/features/speak/`)

Put the logic in a hook, `src/features/speak/useSpeak.ts`, with an explicit state machine:
`idle | starting | permission_denied | listening | stopping | processing | slow | complete |
failed`, plus a `disconnected` flag. Keep it UI-free so it can be tested.

How it works underneath (reuse existing code; do not duplicate the pipeline):

- **Speak event.** Recordings need an event. On first use, create one hidden event per user,
  titled "Speak", with `createEvent` (privacy from settings, language Auto). Store its id in the
  settings store as `speakEventId`. Reuse it afterwards; if `getEvent` returns `null`, create a
  new one.
- **Start.** `createLocalSession(event)` with the session's `language_mode` set to the chosen
  language, then `useRecordingStore.getState().start(session, 'Speak', true)`. Personal
  dictation is the user's own voice, so no consent dialog is shown on Speak. Event recordings
  elsewhere keep their consent dialog unchanged. Microphone permission is requested on the
  first Start only, which the store already does.
- **Live text.** While listening, show finalized rows from the live transcript store
  (`useTranscriptStore`) in normal text and provisional text in `muted` italics. Only show
  provisional text if partial events actually arrive. If the stream is not live (laptop not
  connected), show "Recording… Text will appear when your computer is connected." Never fake
  text.
- **Stop.** The UI switches to `stopping` immediately on tap, then `processing`
  ("Turning speech into text…"). It is `complete` when the local session is `finalized`, so poll
  the repo every 1.5 s. After 60 s with no new transcript rows, show the `slow` state:
  "Still working. Your recording is safe on this phone." If the computer is disconnected, show:
  "Your computer isn't connected. Your recording is safe on this phone and will be turned into
  text when it reconnects." with the action "Connect computer". No percentages.
- **Complete.** Join the stored transcript rows' `raw_text`, in sequence order, with spaces, into
  an editable multiline `TextInput` (transcript typography, `fontFor` the text).
  - Edits are a **draft**: save them per session in `src/lib/storage/kv` (debounced). Never write
    edits into the transcript tables or Firestore.
  - **Copy** is the dominant (filled) button. It copies only on tap (`expo-clipboard`) and shows
    an inline "Copied." under the button for 2 s; no toast-only feedback.
  - **Share** is secondary and uses RN `Share.share({ message })`.
  - A "⋯ More" button opens a BottomSheet with:
    - "Original / Cleaned up" (a two-option control, shown only when the session has polished
      text, with the explanation "Fixes punctuation and removes fillers.";
      original is the default);
    - "Open in History";
    - "Delete recording" (with a confirmation that says it deletes the phone and computer
      copies; reuse `deleteSession`).
- **Speak again.** Starts a new session. The previous result stays in History, and its unsaved
  edits stay in its draft. Never lose text.
- **Cancel.** A quiet text button while listening. It asks "Stop and keep the recording?" with
  the choices "Keep" (stop normally) and "Discard" (stop, then `deleteSession`), plus a back
  option to keep recording.
- **Restore.** On open, if the most recent Speak session is unfinished (recording, paused,
  stopped or finalizing), resume showing it, in its correct state. The
  `finalize_status === 'interrupted'` case shows: "Your last recording was interrupted. The
  audio is safe on this phone." with the action "Finish it" (the same action the session screen
  uses).
- **Errors.** Every error uses `InlineNotice` with what happened, whether the work is safe, and
  one action:
  - microphone denied: action "Open settings" (`Linking.openSettings()`);
  - storage low (the existing store messages);
  - the recording store `error` phase: show its message and the action "Stop".
- **Layout, top to bottom.**
  1. A compact header: the wordmark "WhisprPersonal" (label weight, muted) and the
     `StatusLabel`.
  2. `LanguageChip`.
  3. The transcript area (flex 1, scrollable). At rest it shows the supporting line "Speak
     naturally. Your words will appear here."
  4. A bottom dock in thumb reach: the timer and a red dot while listening ("Listening… 00:12"),
     `LevelBars`, `MicButton`, then the result actions row (Copy, Share, ⋯) when complete.

  The dock is fixed at the bottom. The transcript never pushes the button around.

## 6. History tab (`src/app/(app)/history.tsx`)

This is a simple first version; polish comes in a later phase.
- List all local sessions for the user, newest first, grouped "Today", "Yesterday" and
  "Earlier" (device locale).
- Each row shows:
  - a 2-line preview of the transcript text, or "Turning speech into text…", "No text yet" or
    "Interrupted";
  - the time, the language name and the duration.
- Search filters by preview text.
- Tapping a row opens the existing `/transcript/[sessionId]` viewer.
- Add a "Copy" action on rows that have text.
- Show an empty state when there is nothing: "Your recordings will appear here."
- At the bottom, a quiet row "Events, notes and briefs" opens `/events`.

## 7. Fix the event recording screen layout (`src/app/session/[sessionId].tsx`)

The owner disliked that the Raw/Polished tabs and transcript sit mid-screen, under a 45%-height
scroll box. Restructure it as:
- the status row;
- then the transcript area (tabs plus list) taking `flex: 1`;
- then a bottom dock holding the timer, the level and `RecordControls`;
- the existing "More options" collapsible, quick note and queue status move into a BottomSheet
  opened by a "⋯ Options" button in the dock.

The record and stop controls stay in place across states. Keep all existing behaviour and
tests.

## 8. Settings additions

Add an "Appearance" group to Settings (System / Light / Dark). Do not restructure the rest of
Settings in this phase.

## Tests (Jest; no network; mock native modules as `jest.setup.ts` already does)

- `contrast.test.ts` (see §1).
- `fonts.test.ts`: `fontFor` picks the correct family for Kannada, Tamil, Hindi, English and
  mixed text.
- `useSpeak` state machine tests with mocked recording store, repo and connection:
  - start, then listening, stop, processing, complete;
  - permission denied;
  - disconnected while processing;
  - slow after 60 s (fake timers);
  - restore of an interrupted session;
  - Cancel with Keep versus Discard (Discard calls `deleteSession`);
  - drafts persist and never write transcript rows.
- Speak screen render tests:
  - at rest, there is exactly one primary button and it is labelled "Start speaking";
  - the language sheet opens and a choice persists in two taps;
  - Copy writes to the mocked clipboard only on press and shows "Copied.".
- History groups by Today, Yesterday and Earlier with fake dates.
- Update existing tests whose routes or labels change (the startup-route test now expects
  Speak). Keep every existing behaviour test passing.

## Constraints

- Follow `AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env`. Do not modify `.gitignore` or `AGENTS.md`.
  Do not run `git commit` or `git push`, and do not change git config.
- Do not change the server, Firestore rules, the recording pipeline internals
  (`recordingStore`, upload, live stream), or the auth flow. Speak only *uses* them.
- No new dependencies beyond the ones listed above. No network calls in tests.
- No fake transcripts, no simulated connection success, no decorative progress percentages.
- Every touch target is at least 48 dp. All new text is scalable (no `allowFontScaling={false}`).

## Done when (from `E:\Whispr\android`)

- `npx tsc --noEmit -p .` passes.
- `npx eslint src` is clean.
- `npx jest` passes, with all existing tests or updated equivalents plus the new ones.
- The final message lists each changed or added file with a one-line reason, any token you
  adjusted for contrast, and anything you could not do.

## Outcome (architect review, 2026-11-16)

Implemented by Codex in one run, then reviewed. Checks: tsc and eslint clean, 479 Jest tests
pass. Architect changes after review: `typography.ts` no longer sets `fontWeight` alongside the
bundled weight-specific font families, because Android can fall back to the system font when both
are set. Device verification (fonts, microphone, layout at large text) is still pending on the
owner's phone.
