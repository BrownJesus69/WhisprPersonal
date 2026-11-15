import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { database } from '../lib/db/database';
import { SQLiteRepositories, transcriptRow, type Repositories } from '../lib/db/repositories';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { translation, translationJob } from './translationFixtures';

test('migration 6 and both repositories isolate translations and delete linked jobs', async () => {
  const sql = new DatabaseSync(':memory:');
  const bind = (args: unknown[]) => (Array.isArray(args[0]) ? args[0] : args) as SQLInputValue[];
  const adapter = {
    execAsync: async (q: string) => { sql.exec(q); },
    getFirstAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).get(...bind(args)) ?? null,
    getAllAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).all(...bind(args)),
    runAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).run(...bind(args)),
    withExclusiveTransactionAsync: async (fn: (tx: unknown) => Promise<void>) => {
      sql.exec('BEGIN IMMEDIATE'); try { await fn(adapter); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  jest.mocked(openDatabaseAsync).mockResolvedValue(adapter as unknown as SQLiteDatabase);
  try {
    const sqlite = new SQLiteRepositories(await database());
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
    expect(sql.prepare('PRAGMA table_info(translations)').all().map(r => r.name).sort()).toEqual(Object.keys(translation()).sort());
    expect(sql.prepare('PRAGMA table_info(translation_jobs)').all().map(r => r.name).sort()).toEqual(Object.keys(translationJob()).sort());
    for (const repo of [sqlite,new MemoryRepositories()] as Repositories[]) {
      await repo.putSession(session()); await repo.putSession(session({ id: 'second' }));
      await repo.upsertTranscript(transcriptRow(session().id,finalData()));
      await repo.storeTranslations(session().id,'en',[translation(),translation({ sequence: 1, text: null, engine: null, model: null, error_code: 'source_unknown' })]);
      await repo.storeTranslations(session().id,'ta',[translation({ target_lang: 'ta', text: 'Tamil' })]);
      await repo.putTranslationJob(translationJob({ session_ids: [session().id,'second'] }));
      expect(await repo.translations(session().id,'en')).toHaveLength(2);
      expect((await repo.transcript(session().id))[0].raw_text).toBe('original');
      await repo.storeTranslations(session().id,'en',[translation({ text: 'Replaced dedicated output' })]);
      expect(await repo.translations(session().id,'en')).toHaveLength(1);
      expect((await repo.translations(session().id,'ta'))[0].text).toBe('Tamil');
      await repo.deleteSessionRows(session().id,'wrong-owner',false);
      expect(await repo.translations(session().id,'en')).toHaveLength(1);
      await repo.deleteSessionRows(session().id,'owner',false);
      expect(await repo.translations(session().id,'en')).toEqual([]);
      expect(await repo.translationJobs('owner')).toEqual([]);
      expect(await repo.session('second')).not.toBeNull();
      await repo.storeTranslations(session().id,'en',[translation()]); await repo.putTranslationJob(translationJob());
      expect(await repo.translations(session().id,'en')).toEqual([]); expect(await repo.translationJobs('owner')).toEqual([]);
    }
  } finally { sql.close(); }
});
