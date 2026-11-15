import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { database } from '../lib/db/database';
import { SQLiteRepositories, transcriptRow, type Repositories } from '../lib/db/repositories';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { notesApi } from '../lib/notes/notes';
import { note, remote } from './noteFixtures';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';

let sql: DatabaseSync, sqlite: SQLiteRepositories;
beforeAll(async () => {
  sql = new DatabaseSync(':memory:');
  const bindings = (args: unknown[]) => (Array.isArray(args[0]) ? args[0] : args) as SQLInputValue[];
  const adapter = {
    execAsync: async (query: string) => { sql.exec(query); },
    getFirstAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).get(...bindings(args)) ?? null,
    getAllAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).all(...bindings(args)),
    runAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).run(...bindings(args)),
    withExclusiveTransactionAsync: async (callback: (tx: unknown) => Promise<void>) => {
      sql.exec('BEGIN IMMEDIATE');
      try { await callback(adapter); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; }
    }
  };
  jest.mocked(openDatabaseAsync).mockResolvedValue(adapter as unknown as SQLiteDatabase);
  sqlite = new SQLiteRepositories(await database());
});
afterAll(() => sql.close());
async function semantics(repo: Repositories) {
  const api = notesApi(repo,'owner',() => {}), other = notesApi(repo,'other',() => {});
  const first = await api.createNote('event-1',{ text: 'ಕನ್ನಡ தமிழ் हिन्दी 100%_\\', speaker: 'Speaker' });
  const second = await api.createNote('event-1',{ text: 'Later', timestampMs: 12000 });
  await other.createNote('event-1',{ text: 'private' });
  await api.createNote('other-event',{ text: 'unrelated' });
  expect((await repo.notes('owner','event-1')).map(n => n.id)).toEqual([first.id,second.id]);
  for (const q of ['ಕನ್ನಡ','தமிழ்','हिन्दी','%_\\','SPEAKER']) expect((await repo.notes('owner','event-1',q)).map(n => n.id)).toEqual([first.id]);
  expect(await repo.searchNotes('owner','private',50)).toEqual([]);
  expect(await repo.notes('stranger','event-1')).toEqual([]);
  expect(await repo.noteEventIds('owner')).toEqual(['event-1','other-event']);
  expect(await repo.noteEventIds('stranger')).toEqual([]);
  await expect(other.editNote(first.id,{ text: 'stolen' })).rejects.toThrow('unavailable');
  await api.editNote(first.id,{ text: 'edited' }); await api.editNote(first.id,{ text: 'again' });
  expect((await repo.note(first.id))?.revision).toBe(3);
  await repo.updateNote(first.id,{ synced_revision: 10 }); await api.deleteNote(first.id);
  expect(await repo.note(first.id)).toMatchObject({ revision: 11, text: '', speaker: null, deleted: 1, sync_state: 'pending' });
  expect(await repo.searchNotes('owner','again',50)).toEqual([]);
  expect((await repo.noteStates('owner','event-1')).filter(s => s === 'pending')).toHaveLength(2);
  expect(await repo.noteStates('stranger','event-1')).toEqual([]);
  expect((await repo.notes('owner','event-1')).map(n => n.id)).toEqual([second.id]);
  await repo.updateNote(first.id,{ sync_state: 'conflict', remote_json: JSON.stringify(remote()) });
  expect(await repo.notes('owner','event-1')).toHaveLength(2); // Deleted conflict remains actionable.
  await repo.putSession(session()); await repo.putSession(session({ id: 'other-session', owner_uid: 'other' }));
  await repo.upsertTranscript(transcriptRow(session().id,finalData({ raw_text: 'ಕನ್ನಡ 100%_\\' })));
  await repo.upsertTranscript(transcriptRow(session().id,finalData({ sequence: 1, raw_text: 'silent', no_speech: true })));
  await repo.upsertTranscript(transcriptRow('other-session',finalData({ raw_text: 'private' })));
  expect(await repo.searchTranscripts('owner','ಕನ್ನಡ',50)).toHaveLength(1);
  expect(await repo.searchTranscripts('owner','%_\\',50)).toHaveLength(1);
  expect(await repo.searchTranscripts('owner','private',50)).toEqual([]);
  expect(await repo.searchTranscripts('owner','silent',50)).toEqual([]);
  expect(await api.searchAll('x')).toEqual({ notes: [], transcripts: [] });
}
test('migration 3 and actual SQLite statements obey same semantics as memory twin', async () => {
  expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
  await semantics(sqlite); await semantics(new MemoryRepositories());
});
test('SQL updates read and write on the same transaction connection', async () => {
  const tx = { getFirstAsync: jest.fn(async () => note()), runAsync: jest.fn(async () => ({})) };
  const db = { withExclusiveTransactionAsync: jest.fn(async (cb: (tx: unknown) => Promise<void>) => cb(tx)), runAsync: jest.fn() };
  const repo = new SQLiteRepositories(db as unknown as SQLiteDatabase);
  await repo.updateNote(note().id, n => ({ revision: n.revision + 1 }));
  expect(tx.getFirstAsync).toHaveBeenCalledWith('SELECT * FROM notes WHERE id=?', note().id);
  expect(tx.runAsync).toHaveBeenCalledWith('UPDATE notes SET revision=? WHERE id=?',[2,note().id]);
  expect(db.runAsync).not.toHaveBeenCalled();
});
test('pending cap, due filtering, stable ordering and owner isolation in memory', async () => {
  const repo = new MemoryRepositories();
  for (let i = 0; i < 55; i++) await repo.putNote(note({ id: String(i).padStart(2,'0') }));
  await repo.putNote(note({ id: 'future', next_attempt_at: 10000 })); await repo.putNote(note({ id: 'other', owner_uid: 'other' }));
  const rows = await repo.pendingNotes('owner',1000); expect(rows).toHaveLength(50); expect(rows[0].id).toBe('00'); expect(rows[49].id).toBe('49');
});
test('failures retry with a fresh revision; conflict edits retain both texts; cloud choice is explicit', async () => {
  const repo = new MemoryRepositories(), api = notesApi(repo,'owner',() => {});
  await repo.putNote(note({ sync_state: 'failed', revision: 4, synced_revision: 5 }));
  await api.retryFailed(note().id); expect(await repo.note(note().id)).toMatchObject({ revision: 6, sync_state: 'pending' });
  await repo.updateNote(note().id,{ sync_state: 'conflict', remote_json: JSON.stringify(remote({ revision: 9 })) });
  await api.editNote(note().id,{ text: 'conflict edit' }); expect(await repo.note(note().id)).toMatchObject({ revision: 7, sync_state: 'conflict', text: 'conflict edit' });
  await api.keepMine(note().id); expect(await repo.note(note().id)).toMatchObject({ revision: 10, synced_revision: 9, sync_state: 'pending' });
  await expect(api.createNote('event-1',{ text: 'AI', source: 'ai' })).rejects.toThrow('not configured');
});
test('transcript-derived note retains raw source text; missing note mutations fail locally', async () => {
  const repo = new MemoryRepositories(), api = notesApi(repo,'owner',() => {});
  const created = await api.createNote('event-1',{ text: ' raw source text ', source: 'transcript', sequence: 2, language: 'kn', timestampMs: 4000 });
  expect(created).toMatchObject({ text: ' raw source text ', sequence: 2, language: 'kn', timestamp_ms: 4000 });
  await expect(api.editNote('missing',{ text: 'hello' })).rejects.toThrow('unavailable');
});
test('both repositories cap searches and sort newest results first', async () => {
  for (const repo of [sqlite,new MemoryRepositories()]) {
    await repo.putSession(session({ id: 'cap-session', owner_uid: 'cap' }));
    for (let i = 0; i < 55; i++) {
      const updated_at = new Date(1000 + i * 1000).toISOString();
      await repo.putNote(note({ id: `cap-${i}`, owner_uid: 'cap', text: 'match', search_text: 'match ', updated_at }));
      await repo.upsertTranscript(transcriptRow('cap-session',finalData({ sequence: i, raw_text: 'match' }),updated_at));
    }
    const notes = await repo.searchNotes('cap','match',50), transcripts = await repo.searchTranscripts('cap','match',50);
    expect(notes).toHaveLength(50); expect(notes[0].id).toBe('cap-54');
    expect(transcripts).toHaveLength(50); expect(transcripts[0].sequence).toBe(54);
    expect(await repo.pendingNotes('cap',1000)).toHaveLength(50);
  }
});
