import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

let opening: Promise<SQLiteDatabase> | undefined;
export function database(): Promise<SQLiteDatabase> {
  return opening ??= open().catch(error => { opening = undefined; throw error; });
}
async function open() {
  const db = await openDatabaseAsync('whispr.db');
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) < 1) await db.withExclusiveTransactionAsync(async tx => {
    await tx.execAsync(`
      CREATE TABLE IF NOT EXISTS recording_sessions (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, owner_uid TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('recording','paused','stopped','interrupted','finalizing','finalized','failed')),
        language_mode TEXT NOT NULL, expected_languages TEXT NOT NULL, chunk_ms INTEGER NOT NULL,
        overlap_ms INTEGER NOT NULL, next_sequence INTEGER NOT NULL, time_ms INTEGER NOT NULL,
        master_uri TEXT NOT NULL, server_created INTEGER NOT NULL, expected_chunk_count INTEGER,
        finalize_status TEXT, consent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES recording_sessions(id),
        sequence INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        overlap_ms INTEGER NOT NULL, continues INTEGER NOT NULL, uri TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','uploading','uploaded','transcribed','failed_permanent')),
        server_status TEXT, attempts INTEGER NOT NULL, next_attempt_at REAL NOT NULL,
        last_error TEXT, local_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS chunks_work ON chunks(status, next_attempt_at);
      PRAGMA user_version = 1;
    `);
  });
  if ((version?.user_version ?? 0) < 2) await db.withExclusiveTransactionAsync(async tx => {
    await tx.execAsync(`
      CREATE TABLE transcript_chunks (
        session_id TEXT NOT NULL REFERENCES recording_sessions(id), sequence INTEGER NOT NULL,
        chunk_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        raw_text TEXT NOT NULL, segments_json TEXT NOT NULL, detected_language TEXT,
        language_confidence REAL, language_source TEXT NOT NULL, language_uncertain INTEGER NOT NULL,
        no_speech INTEGER NOT NULL, failed_code TEXT, revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, PRIMARY KEY(session_id, sequence)
      );
      CREATE TABLE language_events (
        session_id TEXT NOT NULL REFERENCES recording_sessions(id), seq INTEGER NOT NULL,
        type TEXT NOT NULL, language TEXT, from_language TEXT, at_sequence INTEGER,
        confidence REAL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, seq)
      );
      -- Retain validated lifecycle/failure events too, for faithful offline hydration.
      CREATE TABLE stream_events (
        session_id TEXT NOT NULL REFERENCES recording_sessions(id), seq INTEGER NOT NULL,
        event_json TEXT NOT NULL, PRIMARY KEY(session_id, seq)
      );
      ALTER TABLE recording_sessions ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE recording_sessions ADD COLUMN language_override TEXT NOT NULL DEFAULT 'auto';
      ALTER TABLE recording_sessions ADD COLUMN override_from_sequence INTEGER;
      ALTER TABLE recording_sessions ADD COLUMN server_finalized_at TEXT;
      PRAGMA user_version = 2;
    `);
  });
  return db;
}
