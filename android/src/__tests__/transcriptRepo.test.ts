import { SQLiteRepositories, transcriptRow, TRANSCRIPT_UPSERT } from '../lib/db/repositories';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import type { SQLiteDatabase } from 'expo-sqlite';
import { session } from './recordingFixtures';
import { finalData, finalEvent, liveId } from './liveFixtures';
import { useTranscriptStore } from '../lib/live/transcriptStore';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { database } from '../lib/db/database';

test('memory upserts idempotently, increments revision only on text changes, sorts sequence', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session());
  const row = transcriptRow(liveId, finalData());
  await repo.upsertTranscript(row); await repo.upsertTranscript(row);
  await repo.upsertTranscript({ ...row, language_confidence: 0.5 }); expect((await repo.transcript(liveId))[0].revision).toBe(0);
  await repo.upsertTranscript({ ...row, raw_text: 'revision' }); expect((await repo.transcript(liveId))[0].revision).toBe(1);
  await repo.upsertTranscript(transcriptRow(liveId, finalData({ sequence: 2 })));
  expect((await repo.transcript(liveId)).map(r => r.sequence)).toEqual([0,2]);
});
test('persist event atomically advances monotonic cursor; reset allows replay', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session()); await repo.persistEvent(finalEvent(4));
  await repo.persistEvent(finalEvent(4, { raw_text: 'duplicate' })); await repo.persistEvent(finalEvent(3)); await repo.setLastEventSeq(liveId, 1);
  expect((await repo.session(liveId))?.last_event_seq).toBe(4); expect((await repo.transcript(liveId))[0].raw_text).toBe('original');
  expect(await repo.streamEvents(liveId)).toHaveLength(1); await repo.resetLastEventSeq(liveId);
  expect((await repo.session(liveId))?.last_event_seq).toBe(0); expect(await repo.streamEvents(liveId)).toEqual([]);
  await repo.persistEvent(finalEvent(1, { raw_text: 'new server' })); expect((await repo.transcript(liveId))[0].revision).toBe(1);
});
test('language event idempotence and offline hydration of final/revised/failure/finalization', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session());
  await repo.persistEvent(finalEvent(1)); await repo.persistEvent(finalEvent(2, { raw_text: 'updated' }, true));
  const base = { session_id: liveId, ts: 'now' };
  await repo.persistEvent({ ...base, type: 'language_locked', seq: 3, data: { language: 'kn', confidence: 0.92, at_sequence: 0 } });
  await repo.persistEvent({ ...base, type: 'chunk_failed', seq: 4, data: { chunk_id: 'c1', sequence: 1, error_code: 'decode_failed' } });
  await repo.persistEvent({ ...base, type: 'session_finalized', seq: 5, data: { transcript_status: 'partial', missing_sequences: [], failed_sequences: [1] } });
  await repo.setLanguageOverride(liveId, 'ta', 2);
  const l = (await repo.languageEvents(liveId))[0]; await repo.appendLanguageEvent(l); expect(await repo.languageEvents(liveId)).toHaveLength(1);
  useTranscriptStore.setState({ sessions: {} }); await useTranscriptStore.getState().hydrate(repo, liveId);
  const model = useTranscriptStore.getState().sessions[liveId].model;
  expect(model.finals.get(0)).toMatchObject({ raw_text: 'updated', revision: 1 }); expect(model.failed.get(1)).toBe('decode_failed');
  expect(model.language.mode).toBe('ta'); expect(model.finalized?.failed).toEqual([1]); expect(model.lastSeq).toBe(5);
});
test('SQL event mutations and MAX cursor share the exclusive transaction connection', async () => {
  const tx = { getFirstAsync: jest.fn(async () => ({ last_event_seq: 0 })), runAsync: jest.fn(async () => ({})) };
  const db = { withExclusiveTransactionAsync: jest.fn(async (callback: (tx: unknown) => Promise<void>) => callback(tx)), runAsync: jest.fn() };
  const repo = new SQLiteRepositories(db as unknown as SQLiteDatabase);
  await repo.persistEvent(finalEvent(1)); expect(db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1); expect(db.runAsync).not.toHaveBeenCalled();
  const sql = tx.runAsync.mock.calls as unknown as [string, ...unknown[]][];
  expect(sql[0][0]).toBe(TRANSCRIPT_UPSERT); expect(sql[1][0]).toContain('INSERT INTO stream_events'); expect(sql[2][0]).toContain('last_event_seq=MAX');
  expect(TRANSCRIPT_UPSERT).toContain('CASE WHEN transcript_chunks.raw_text != excluded.raw_text THEN 1 ELSE 0 END');
  tx.getFirstAsync.mockResolvedValue({ last_event_seq: 1 }); tx.runAsync.mockClear(); await repo.persistEvent(finalEvent(1)); expect(tx.runAsync).not.toHaveBeenCalled();
});
test('poll-only transcript rows hydrate without inventing an event cursor', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session()); await repo.upsertTranscript(transcriptRow(liveId, finalData()));
  useTranscriptStore.setState({ sessions: {} }); await useTranscriptStore.getState().hydrate(repo, liveId);
  expect(useTranscriptStore.getState().sessions[liveId].model.finals.size).toBe(1); expect(useTranscriptStore.getState().sessions[liveId].model.lastSeq).toBe(0);
});

test('real SQLite migration 1→2, idempotent revision, cursor rollback, and reset', async () => {
  const sql = new DatabaseSync(':memory:');
  const bindings = (args: unknown[]) => (Array.isArray(args[0]) ? args[0] : args) as SQLInputValue[];
  let failCursor = false;
  const adapter = {
    execAsync: async (query: string) => {
      sql.exec(query);
      if (query.includes('PRAGMA user_version = 1;')) {
        // Seed a Phase 5 row before migration 2 runs, inside the production migration lane.
        const old = { ...session({ id: 'existing_phase5' }), expected_languages: '[]' };
        sql.prepare(`INSERT INTO recording_sessions (${Object.keys(old).join(',')}) VALUES (${Object.keys(old).map(() => '?').join(',')})`).run(...Object.values(old) as SQLInputValue[]);
      }
    },
    getFirstAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).get(...bindings(args)) ?? null,
    getAllAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).all(...bindings(args)),
    runAsync: async (query: string, ...args: unknown[]) => {
      if (failCursor && query.includes('SET last_event_seq=MAX')) throw new Error('Simulated write failure');
      return sql.prepare(query).run(...bindings(args));
    },
    withExclusiveTransactionAsync: async (callback: (tx: unknown) => Promise<void>) => {
      sql.exec('BEGIN IMMEDIATE');
      try { await callback(adapter); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; }
    }
  };
  jest.mocked(openDatabaseAsync).mockResolvedValue(adapter as unknown as SQLiteDatabase);
  try {
    const db = await database(); // Runs actual production migrations against in-memory SQLite.
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    const repo = new SQLiteRepositories(db); await repo.putSession(session());
    expect(await repo.session('existing_phase5')).toMatchObject({ last_event_seq: 0, language_override: 'auto', override_from_sequence: null, status: 'recording' });
    failCursor = true; await expect(repo.persistEvent(finalEvent(1))).rejects.toThrow('Simulated write failure');
    expect(await repo.transcript(liveId)).toEqual([]); expect(await repo.streamEvents(liveId)).toEqual([]); expect((await repo.session(liveId))?.last_event_seq).toBe(0);
    failCursor = false; await repo.persistEvent(finalEvent(1)); await repo.persistEvent(finalEvent(1));
    await repo.upsertTranscript(transcriptRow(liveId, finalData())); expect((await repo.transcript(liveId))[0].revision).toBe(0);
    await repo.persistEvent(finalEvent(2, { raw_text: 'revision' }, true)); expect((await repo.transcript(liveId))[0].revision).toBe(1);
    await repo.setLastEventSeq(liveId, 1); expect((await repo.session(liveId))?.last_event_seq).toBe(2);
    await repo.upsertTranscript(transcriptRow(liveId, finalData()), 1); expect((await repo.transcript(liveId))[0].raw_text).toBe('revision');
    await repo.setLanguageOverride(liveId, 'ta', 3); expect((await repo.session(liveId))?.override_from_sequence).toBe(3);
    await repo.resetLastEventSeq(liveId); expect((await repo.session(liveId))?.last_event_seq).toBe(0); expect(await repo.streamEvents(liveId)).toEqual([]);
  } finally { sql.close(); }
});
