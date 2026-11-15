import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { database } from '../lib/db/database';
import { SQLiteRepositories, transcriptRow, type Repositories } from '../lib/db/repositories';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { aiJob, draft } from './aiFixtures';

let sql: DatabaseSync, sqlite: SQLiteRepositories;
beforeAll(async () => {
  sql = new DatabaseSync(':memory:');
  const bind = (args: unknown[]) => (Array.isArray(args[0]) ? args[0] : args) as SQLInputValue[];
  const adapter = {
    execAsync: async (q: string) => {
      sql.exec(q);
      if (q.includes('PRAGMA user_version = 3;')) {
        // Seed the v3 boundary before production migration 4 runs.
        const old = { ...session({ id: 'phase7_session' }), expected_languages: '[]' };
        sql.prepare(`INSERT INTO recording_sessions (${Object.keys(old).join(',')}) VALUES (${Object.keys(old).map(() => '?').join(',')})`).run(...Object.values(old) as SQLInputValue[]);
        sql.exec(`INSERT INTO transcript_chunks (session_id,sequence,chunk_id,start_ms,end_ms,raw_text,segments_json,language_source,language_uncertain,no_speech,updated_at)
          VALUES ('phase7_session',0,'old_chunk',0,1000,'Existing raw words','[]','auto',0,0,'2026-11-15');`);
      }
    },
    getFirstAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).get(...bind(args)) ?? null,
    getAllAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).all(...bind(args)),
    runAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).run(...bind(args)),
    withExclusiveTransactionAsync: async (fn: (tx: unknown) => Promise<void>) => {
      sql.exec('BEGIN IMMEDIATE'); try { await fn(adapter); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  jest.mocked(openDatabaseAsync).mockResolvedValue(adapter as unknown as SQLiteDatabase);
  sqlite = new SQLiteRepositories(await database());
});
afterAll(() => sql.close());
test('migration 4 creates the exact AI storage columns', () => {
  expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
  for (const [table, keys] of Object.entries({ ai_jobs: Object.keys(aiJob()), brief_drafts: Object.keys(draft()) })) {
    expect(sql.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).sort()).toEqual(keys.sort());
  }
  expect(sql.prepare('PRAGMA table_info(transcript_chunks)').all().map(c => c.name)).toEqual(expect.arrayContaining(['polished_text','polished_level','polish_error']));
});
test('migration 3 to 4 retains existing raw rows and initializes polish to null', async () => {
  expect((await sqlite.transcript('phase7_session'))[0]).toMatchObject({ raw_text: 'Existing raw words', polished_text: null, polished_level: null, polish_error: null });
});
async function semantics(repo: Repositories) {
  const id = session().id; await repo.putSession(session());
  const row = transcriptRow(id, finalData()); await repo.upsertTranscript(row);
  const cleaned = { sequence: 0, polished_text: 'Polished', polished_level: 'polished' as const, polish_error: null };
  await repo.storePolished(id,[cleaned],await repo.transcript(id));
  await repo.upsertTranscript({ ...row, language_confidence: 0.6, polished_text: 'must not overwrite' });
  expect((await repo.transcript(id))[0]).toMatchObject({ raw_text: 'original', polished_text: 'Polished', polished_level: 'polished' });
  const originals = await repo.transcript(id);
  await repo.upsertTranscript({ ...row, raw_text: 'revised raw' });
  expect((await repo.transcript(id))[0]).toMatchObject({ raw_text: 'revised raw', polished_text: null, polished_level: null, polish_error: null, revision: 1 });
  await repo.storePolished(id,[cleaned],originals); // response raced with seam revision
  expect((await repo.transcript(id))[0].polished_text).toBeNull();
  await repo.storePolished(id,[{ ...cleaned, polished_text: null, polished_level: null, polish_error: 'ai_output_invalid' }],await repo.transcript(id));
  await repo.upsertTranscript({ ...row, raw_text: 'revised raw' });
  expect((await repo.transcript(id))[0].polish_error).toBe('ai_output_invalid');
  await repo.putAIJob(aiJob()); await repo.putAIJob(aiJob({ status: 'running' }));
  await repo.putAIJob(aiJob({ owner_uid: 'other', event_id: 'other-event', status: 'running' }));
  expect(await repo.aiJobs('other')).toEqual([]); expect(await repo.aiJobs('owner','other-event')).toEqual([]);
  await repo.finishAIJob(aiJob({ owner_uid: 'other', status: 'failed' }));
  expect((await repo.aiJobs('owner'))[0].status).toBe('running');
  await repo.finishAIJob(aiJob({ status: 'done' }),draft());
  await repo.putBriefDraft(draft({ edited_text: 'Owner edits' }));
  await repo.finishAIJob(aiJob({ status: 'done' }),draft());
  expect(await repo.briefDrafts('owner','event-1')).toHaveLength(1);
  expect((await repo.briefDrafts('owner','event-1'))[0]).toMatchObject({ edited_text: 'Owner edits', generated_text: 'Generated text' });
  await repo.deleteBriefDraft('other',draft().id); expect(await repo.briefDrafts('owner','event-1')).toHaveLength(1);
  await repo.putBriefDraft(draft({ status: 'saved', edited_text: 'Final' })); await repo.deleteBriefDraft('owner',draft().id);
  expect((await repo.briefDrafts('owner','event-1'))[0].status).toBe('saved');
  const second = draft({ id: 'discard-me' }); await repo.putBriefDraft(second); await repo.deleteBriefDraft('owner',second.id);
  expect(await repo.briefDrafts('owner','event-1')).toHaveLength(1);
}
test('SQLite and memory twin preserve raw text, polish, jobs and draft edits identically', async () => {
  await semantics(sqlite); await semantics(new MemoryRepositories());
});
test('draft insertion rolls back if terminal job persistence fails', async () => {
  await sqlite.putAIJob(aiJob({ job_id: 'rollback' }));
  sql.exec("CREATE TRIGGER fail_job BEFORE UPDATE ON ai_jobs WHEN NEW.job_id='rollback' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await expect(sqlite.finishAIJob(aiJob({ job_id: 'rollback', status: 'done' }),draft({ id: 'rollback-draft' }))).rejects.toThrow();
  expect((await sqlite.briefDrafts('owner','event-1')).some(d => d.id === 'rollback-draft')).toBe(false);
  expect((await sqlite.aiJobs('owner')).find(j => j.job_id === 'rollback')?.status).toBe('queued');
});


test('session deletion is one atomic transaction, retains notes, and records server retry', async () => {
  const id = 'delete-session';
  await sqlite.putSession(session({ id }));
  await sqlite.upsertTranscript(transcriptRow(id,finalData()));
  await sqlite.putAIJob(aiJob({ job_id: 'delete-job',session_ids: [id] }));
  sql.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON recording_sessions WHEN OLD.id='delete-session' BEGIN SELECT RAISE(ABORT,'blocked'); END;");
  await expect(sqlite.deleteSessionRows(id,'owner',true)).rejects.toThrow();
  expect(await sqlite.transcript(id)).toHaveLength(1);
  expect(await sqlite.pendingServerDeletes('owner')).toEqual([]);
  expect((await sqlite.aiJobs('owner')).some(j => j.job_id === 'delete-job')).toBe(true);
  sql.exec('DROP TRIGGER fail_delete');
  await sqlite.deleteSessionRows(id,'other',true); expect(await sqlite.session(id)).not.toBeNull();
  await sqlite.deleteSessionRows(id,'owner',true);
  expect(await sqlite.session(id)).toBeNull(); expect(await sqlite.transcript(id)).toEqual([]);
  expect((await sqlite.aiJobs('owner')).some(j => j.job_id === 'delete-job')).toBe(false);
  expect(await sqlite.pendingServerDeletes('owner')).toEqual([{ session_id: id,event_id: 'event-1',owner_uid: 'owner' }]);
  await sqlite.clearServerDelete(id,'other'); expect(await sqlite.pendingServerDeletes('owner')).toHaveLength(1);
  await sqlite.clearServerDelete(id,'owner'); expect(await sqlite.pendingServerDeletes('owner')).toEqual([]);
});
