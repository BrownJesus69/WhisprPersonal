# Fix: "Audio could not be saved" during recording

Working directory: `E:\Whispr` (monorepo root). The app is in `android/` (Expo SDK 58, React
Native, TypeScript, expo-router, zustand, expo-sqlite 58.0.17). Run commands from `android/`.

## Goal

Stop recordings from failing with "Audio could not be saved" when SQLite writes collide, and
make any remaining save failure say what happened instead of swallowing the error.

## Diagnosis (by the architect; read before coding)

- `expo-sqlite`'s `withExclusiveTransactionAsync` opens a **brand-new native connection per call**
  (`Transaction.createAsync` uses `useNewConnection: true`, see
  `node_modules/expo-sqlite/src/SQLiteDatabase.ts:798`).
- No connection sets `PRAGMA busy_timeout`, so SQLite's default timeout is 0: a write that meets
  another connection's write lock fails at once with `SQLITE_BUSY` ("database is locked").
- During recording, writes overlap constantly: `insertChunk` (every chunk, from
  `src/lib/session/recordingStore.ts` `enqueue`), the upload service's `updateChunk`, and
  live-transcript, language-event and stream-event upserts. There are 23
  `withExclusiveTransactionAsync` call sites under `src/lib`.
- In `recordingStore.ts`, `enqueue` catches any error, sets `writeFailed = true` permanently and
  calls `failure()`. From then on every PCM buffer is dropped from chunking for the rest of the
  recording. The level meter keeps moving, which matches the owner's screenshot.

## Scope (files you may change)

1. `android/src/lib/db/database.ts`: after opening, also run `PRAGMA busy_timeout = 5000;` on the
   main connection.
2. A new `android/src/lib/db/writeQueue.ts` exporting
   `writeTransaction(db: SQLiteDatabase, task: (tx: Transaction) => Promise<void>): Promise<void>`.
   - It serialises **all** write transactions in this JS runtime through one promise-chain mutex.
     A failed task must not block later ones.
   - Inside each transaction it first runs `PRAGMA busy_timeout = 5000` on the transaction
     connection, so a lock held by another process or connection waits instead of failing.
   - Export a small test seam if needed (e.g. reset the queue for tests), but keep no global
     mutable state beyond the single queue promise.
3. Replace **every** `db.withExclusiveTransactionAsync(...)` / `this.db.withExclusiveTransactionAsync(...)`
   under `android/src/lib` (including `database.ts` migrations, `repositories.ts`, and any other
   repo files) with `writeTransaction(db, ...)`. Behaviour inside each task must not change.
4. `android/src/lib/session/recordingStore.ts`:
   - In `enqueue`, retry a failed chunk write (`d.write` plus `insertChunk`) up to 3 attempts with
     short backoff (e.g. 250 ms, then 1000 ms), injectable through `Dependencies` so tests do not
     sleep (e.g. add `wait: (ms: number) => Promise<void>` to `Dependencies`). Re-use the same
     `spec`, and do not create duplicate chunk rows: if the file was written but `insertChunk`
     failed, retry only the insert for that file, or delete the orphan file before rewriting.
     The UNIQUE(session_id, sequence) constraint must never be violated by a retry.
   - Only after the retries are exhausted, set `writeFailed` and call `failure()`.
   - `failure(error)` must persist a safe one-line reason to the session row's `last_error`
     (e.g. `chunk_save_failed: database is locked`). Strip file paths and URIs, max 200 chars.
     It keeps the existing user message but makes it honest and actionable:
     "Saving audio on this phone failed. The full recording is still being kept. Tap Stop, then
     reopen the app to recover it." Persisting `last_error` must itself not throw out of `failure`.
   - The `start()` catch must also pass its error to `failure`.
   - Do not change the recorder or master-WAV behaviour.
5. Tests in `android/src/__tests__/` (Jest, no network, no real SQLite):
   - `writeQueue.test.ts`: concurrent `writeTransaction` calls run strictly one at a time, in
     call order; a failing task rejects its own caller only; `PRAGMA busy_timeout` is executed
     inside each transaction. Use a fake `SQLiteDatabase` whose `withExclusiveTransactionAsync`
     records calls.
   - Extend `recordingStore.test.ts`: (a) one transient `insertChunk` failure is retried and the
     recording stays in `recording` with no error; the chunk is stored exactly once; (b) a
     persistent failure ends in phase `error`, with `last_error` set on the session, the new
     message, and no paths in `last_error`.
   - Update any existing test that asserts the old failure message.

## Constraints

- Follow `E:\Whispr\AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env` file. Do not modify `.gitignore` or
  `AGENTS.md`. Do not run `git commit`, `git push` or change git config.
- No new dependencies. No network calls in tests.
- Do not change UI files except where a test needs the new message. A full UI redesign is a
  separate task; do not start it.
- Keep code style: TypeScript strict, ESLint clean, small modules.

## Done when (run from `E:\Whispr\android`)

- `npx tsc --noEmit -p .` passes.
- `npx eslint src` passes with no warnings.
- `npx jest` passes, with all 433 existing tests or their updated equivalents plus the new ones.
- `grep -rn "withExclusiveTransactionAsync" src/lib` shows only the single call inside
  `writeQueue.ts`.
- In the final message, list each changed file with a one-line reason.
