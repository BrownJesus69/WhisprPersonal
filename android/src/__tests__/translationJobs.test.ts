import { TranslationJobRunner } from '../lib/translation/jobs';
import { TranslationAPI } from '../lib/translation/api';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { transcriptRow } from '../lib/db/repositories';
import { ServerError, type ServerClient } from '../lib/server/client';
import { translation, translationJob } from './translationFixtures';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
const request = { event_id: 'event-1', session_ids: [session().id], target_lang: 'en' as const, polish: false };
const done = { job_id: 'translation_one', status: 'done', error_code: null, result: { translated: 1, skipped: 0, failed: 0 } };
async function setup() {
  const repo = new MemoryRepositories(); await repo.putSession(session({ status: 'finalized' }));
  const get = jest.fn(), post = jest.fn(async () => ({ job_id: 'translation_one', status: 'queued' }));
  const api = new TranslationAPI({ get, post } as unknown as ServerClient);
  let now = 0;
  const clock = { now: () => now, setTimeout: jest.fn(), clearTimeout: jest.fn() };
  const runner = new TranslationJobRunner({ repo, api, owner: 'owner', clock });
  return { repo, api, get, post, runner, clock, advance: (ms: number) => { now += ms; } };
}
test('submission is durable and scoped to finalized owned sessions', async () => {
  const t = await setup(); await t.runner.submit(request);
  expect(await t.repo.translationJobs('owner')).toHaveLength(1); expect(await t.repo.translationJobs('other')).toEqual([]);
  await t.repo.updateSession(session().id,{ status: 'recording' });
  await expect(t.runner.submit(request)).rejects.toMatchObject({ code: 'transcript_incomplete' });
  await t.repo.updateSession(session().id,{ status: 'finalized', owner_uid: 'someone' });
  await expect(t.runner.submit(request)).rejects.toMatchObject({ code: 'transcript_incomplete' });
  expect(t.post).toHaveBeenCalledTimes(1);
});
test('restart resumes job, stores translations separately and preserves raw', async () => {
  const t = await setup(); await t.repo.putTranslationJob(translationJob()); await t.repo.upsertTranscript(transcriptRow(session().id,finalData()));
  t.get.mockResolvedValueOnce(done).mockResolvedValueOnce({ session_id: session().id, target_lang: 'en', chunks: [translation()] });
  const runner = new TranslationJobRunner({ repo: t.repo, api: t.api, owner: 'owner', clock: t.clock });
  await runner.tick(); await runner.tick();
  expect(t.get).toHaveBeenCalledTimes(2); expect(t.post).not.toHaveBeenCalled();
  expect(await t.repo.translations(session().id,'en')).toEqual([translation()]);
  expect((await t.repo.transcript(session().id))[0].raw_text).toBe('original');
  expect((await t.repo.translationJobs('owner'))[0].status).toBe('done');
});
test('fetch failure keeps job pollable with backoff, without resubmission', async () => {
  const t = await setup(); await t.repo.putTranslationJob(translationJob());
  t.get.mockResolvedValueOnce(done).mockRejectedValueOnce(new Error('offline'));
  await t.runner.tick(); expect((await t.repo.translationJobs('owner'))[0].status).toBe('queued');
  t.advance(3999); await t.runner.tick(); expect(t.get).toHaveBeenCalledTimes(2);
  t.advance(1); t.get.mockResolvedValueOnce(done).mockResolvedValueOnce({ session_id: session().id, target_lang: 'en', chunks: [] });
  await t.runner.tick(); expect((await t.repo.translationJobs('owner'))[0].status).toBe('done'); expect(t.post).not.toHaveBeenCalled();
});
test.each(['failed','interrupted','404'] as const)('terminal %s is durable', async state => {
  const t = await setup(); await t.repo.putTranslationJob(translationJob());
  if (state === '404') t.get.mockRejectedValue(new ServerError(404,'not_found','gone'));
  else t.get.mockResolvedValue({ job_id: 'translation_one', status: state, error_code: null, result: null });
  await t.runner.tick(); t.advance(60000); await t.runner.tick();
  expect(t.get).toHaveBeenCalledTimes(1); expect((await t.repo.translationJobs('owner'))[0].status).toBe(state === '404' ? 'failed' : state);
});
test('stop prevents applying a late response', async () => {
  const t = await setup(); await t.repo.putTranslationJob(translationJob());
  let resolve!: (v: unknown) => void; t.get.mockImplementation(() => new Promise(r => { resolve = r; }));
  const polling = t.runner.tick(); await Promise.resolve(); await Promise.resolve(); await t.runner.stop(); resolve(done); await polling;
  expect((await t.repo.translationJobs('owner'))[0].status).toBe('queued'); expect(await t.repo.translations(session().id,'en')).toEqual([]);
});
