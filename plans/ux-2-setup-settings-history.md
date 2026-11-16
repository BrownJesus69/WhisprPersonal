# UX-2: First-time setup, Settings, and History

Working directory: `E:\Whispr`. The app is in `android/` (Expo SDK 58, React Native, TypeScript
strict, expo-router 58, zustand, @tanstack/react-query, expo-sqlite). Run commands from
`E:\Whispr\android`. Read `E:\Whispr\AGENTS.md` first and follow it.

This continues the redesign. Phase UX-1 is done (see `plans/ux-1-speak.md`). It added design
tokens (`src/theme`), the strings module (`src/i18n`), the UI components in `src/components/ui/`
(BottomSheet, MicButton, LevelBars, StatusLabel, LanguageChip, InlineNotice), the Speak tab
(`src/app/(app)/index.tsx` with `src/features/speak/useSpeak.ts`), a first History tab
(`src/app/(app)/history.tsx`), and the System/Light/Dark appearance setting. Reuse all of these;
do not duplicate them.

## Owner decisions (fixed)

- Sign-in stays required. Transcripts are kept by default.
- Recognition runs only on the owner's computer (the laptop server). There is **no on-phone
  recognition**. Say "On your computer" and never offer "On this phone" processing.
- The voice keyboard is the next phase (UX-3); do not add IME code here.

## Product principles (from the owner's brief; apply everywhere you touch)

- Plain words: "Connect computer", not "server URL"; "Personal words", not "vocabulary". Technical
  names appear only under Advanced.
- One visually dominant action per screen. Hide advanced options until asked.
- Every problem says what happened, whether the user's work is safe, and one next action. Use
  `InlineNotice`.
- Never claim something works when it does not. Unconfigured means "Not set up", not an error.
- All new user-facing strings go through `t()` in `src/i18n/en.ts`. No sentence fragments.
- 48 dp minimum touch targets. Scalable text. No colour-only status.

## 1. First-time setup (`src/app/setup/`, new)

A short flow shown **once** after sign-in, and resumable later.

- Add `onboarding: 'pending' | 'done'` to the settings store, with normalization and tests.
  - Existing installs that already have a `serverUrl` saved are treated as `done`, so the owner
    is not sent through setup again.
  - New installs default to `'pending'`.
- Gating: in the signed-in branch, if `onboarding === 'pending'`, redirect to `/setup` once. Do
  this with a `Redirect` or `router.replace` in the `(app)` layout, not by changing the auth
  guards. Every step has "Not now". Choosing it marks onboarding `done` and goes to Speak.
- **Step 1, "Choose your language".** The same list as `LanguageSheet` (Auto-detect plus the
  `LANGUAGES` with native names), as full-width rows. It saves `defaultLanguageMode`.
- **Step 2, "Connect your computer".** The steps run in order, and each is shown as its own row
  with a status: waiting, checking (spinner), passed (✓ plus text) or failed (✕ plus a plain
  reason):
  1. "Computer reachable" (`/health`);
  2. "Server key accepted" and "Signed in" (`/api/v1/auth/check`);
  3. "Speech recognition ready" (health `model.status === 'ready'`; when it is loading, say
     "Still loading on your computer" and offer "Check again").

  Inputs are the address (with "Scan QR") and the server key. Reuse the logic in
  `src/app/connect.tsx` by extracting it into `src/features/connect/useConnectComputer.ts`, and
  make **both** `/connect` and setup step 2 use that hook. Keep the existing `/connect` tests
  passing; update them only where the extraction requires. Add a short honest note: "Your
  computer must be on and running WhisprPersonal. Audio is sent only to your computer." If the
  address is `http://` on a LAN address or a Tailscale address, do not show a padlock or any
  "secure" badge.
- **Step 3, "Try it".** Explains in one line and has one button, "Start speaking", which finishes
  onboarding and opens the Speak tab. The microphone permission is requested there, by Speak,
  not earlier.

## 2. Settings, reorganised (`src/app/(app)/settings.tsx`)

Use a simple grouped list: group headings, then rows with a title, a one-line description and
a control or a chevron. Do not put a card around every setting. Build a small `SettingsRow` and
`SettingsGroup` in `src/components/ui/` for this.

- **Speech**
  - Language: opens the existing `LanguageSheet`; the row shows the current choice.
  - Recognition: "On your computer". It shows the connection status (reuse `StatusLabel`
    wording) and opens `/connect`.
  - Text cleanup: "Original" or "Cleaned up by default". This reuses `cleanupLevel` (none =
    Original). Under the row, show the real availability from the existing AI status
    (`unavailableReason` in `src/lib/ai/messages.ts`). When it is unavailable, show "Not set up
    on your computer" and keep the control disabled. Never fake it.
  - Personal words: opens `/personal-words` (see §3).
- **Privacy**
  - Keep transcripts on this device (switch, default **on**). See §4 for what off means.
  - Delete phone audio after it is turned into text: the existing
    `deleteLocalAudioAfterTranscription` switch, plus the existing "Free up space now" action.
  - Delete all recordings: confirm with exact wording: "Deletes every recording and its text
    from this phone and your computer. Notes and briefs saved to your account are kept. This
    cannot be undone." It uses `deleteSession` for each session and reports how many were
    deleted and any that failed (for example, "computer not reachable"; the existing deletion
    retry queue applies).
- **Appearance:** System / Light / Dark (existing).
- **Account:** the email address and Sign out (existing behaviour).
- **Advanced:** a collapsed section holding everything technical that already exists:
  - computer address and the offline pass expiry;
  - audio quality, chunk length and overlap;
  - "Cloud AI allowed" privacy mode;
  - Diagnostics, the laptop health panel, translation status, future integrations and the user
    ID.

  Keep the existing labels that tests rely on ("Translation (on your laptop)", "Future
  integrations"), or update those tests.
- **About**
  - App version.
  - Open-source licences: a screen at `/licenses` listing each **direct production dependency**
    of `android/package.json` with its licence. Generate `src/generated/licenses.json` with a
    script `android/scripts/licenses.mjs`, which reads each dependency's
    `node_modules/<pkg>/package.json` `license` field. Run the script once and commit its output.
    Also note "Fonts: Manrope and Noto Sans, SIL Open Font License 1.1".
  - Privacy: a short screen at `/privacy-info`, written in plain words, that is true for this
    app:
    - audio is recorded on the phone and sent only to the user's own computer;
    - text is kept on the phone and on the computer;
    - notes and briefs sync to the user's Firebase account;
    - cloud AI cleanup runs only if the user turns it on and their computer is configured
      for it;
    - nothing is sold or used for ads.

## 3. Personal words (`src/app/personal-words.tsx`, new)

An approachable list ("Add names or words you use often."):

- an "Add a word" text field with an Add button;
- the words as rows, each with a Remove button;
- a Save action.

It edits the **server vocabulary of the user's Speak event**:
- Extract the "find or create the Speak event" logic from `useSpeak.ts` into
  `src/features/speak/speakEvent.ts` (`ensureSpeakEvent(uid)`), and use it from both places.
- Reuse `VocabularyAPI` and `validateTerms` (`src/lib/server/vocabulary.ts`).

When the computer is not connected, show: "Connect your computer to change personal words. Your
list is stored on your computer." with the action "Connect computer". Never promise recognition:
"Helps your computer spell these words. It cannot guarantee them." The per-event Vocabulary
screen stays as it is for events.

## 4. Keep transcripts switch (`src/features/speak/retention.ts`, new)

When "Keep transcripts on this device" is **off**, Speak recordings (only sessions in the user's
Speak event, never event recordings) that are `finalized` are deleted, on both the phone and the
computer, using `deleteSession`:
- when the next Speak recording starts;
- and on app start for any finalized Speak session older than 24 hours.

Unfinished sessions are never deleted. Drafts for deleted sessions are removed from kv. History
shows an explanatory line when the switch is off: "Recordings are removed after you start a new
one or after 24 hours. Turn on Keep transcripts in Settings to keep them." Add tests for the
eligibility logic: finalized only, Speak event only, and age.

## 5. History, polished

- Tapping a History row opens a new detail screen, `src/app/history/[sessionId].tsx`, not the old
  viewer. Extract the result UI from the Speak screen into a shared
  `src/components/ui/TranscriptResult.tsx`, and use it in both places. It has:
  - editable text (the same kv draft keys as Speak, `draftKey` in `useSpeak.ts`);
  - Copy as the dominant action, with "Copied." inline;
  - Share;
  - a "⋯ More" sheet with:
    - Original / Cleaned up (only when polished text exists);
    - "Show timestamps", which opens the existing `/transcript/[sessionId]` viewer;
    - "Delete…".
- Delete is clearly split, in a BottomSheet:
  - "Delete phone audio only": keeps the text, and deletes the session's chunk and master audio
    files on the phone (reuse the chunk-file helpers; mark the chunks `local_deleted`). Disable it
    while the session is not yet finalized, with the reason "Available after the text is ready".
  - "Delete recording and text": deletes from the phone and the computer (`deleteSession`).

  Each option states exactly what it removes, and that it cannot be undone.
- The list keeps the Today / Yesterday / Earlier groups, search and row Copy. Each row also shows
  "Event: <title>" for event recordings, so the two kinds are distinguishable. Speak recordings
  show nothing extra.
- Empty states: when there is no history, show "Your recordings will appear here." with a
  "Start speaking" button that goes to Speak. When retention is off, add the explanatory line
  from §4.

## Tests (Jest; no network; mock native modules as `jest.setup.ts` does)

- Settings store: `onboarding` and `keepTranscripts` normalization, plus the migration (an
  existing `serverUrl` means `done`).
- The setup flow:
  - redirect once when pending;
  - "Not now" marks it done;
  - the connect step shows the three checks with the correct pass/fail rows (mock fetch as
    `components.test.tsx` does);
  - "Start speaking" finishes onboarding.
- `useConnectComputer` reached from both `/connect` and setup: the existing `/connect` tests
  still pass.
- Personal words: add, remove and save calls `VocabularyAPI.save` with validated terms; the
  disconnected state shows the notice.
- Retention eligibility rules, plus deletion running when the next Speak recording starts with
  retention off.
- History detail: Copy, Share, the More sheet, both delete options and their confirmations, and
  that delete-audio-only is disabled until finalized.
- Settings renders the groups, and the Advanced items are hidden until opened.
- The licences script output exists and is valid JSON with name and licence fields.

## Constraints

- Follow `AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env`. Do not modify `.gitignore` or `AGENTS.md`.
  Do not run `git commit` or `git push`, and do not change git config.
- Do not change the server, the Firestore rules, the auth guards, or the recording, upload and
  live pipeline internals.
- No new dependencies. No network calls in tests.
- Keep every existing behaviour test passing, or update it to the new equivalent with the same
  intent.

## Done when (from `E:\Whispr\android`)

- `npx tsc --noEmit -p .` passes.
- `npx eslint src` is clean.
- `npx jest` passes.
- The final message lists each changed or added file with a one-line reason, and anything not
  done.
