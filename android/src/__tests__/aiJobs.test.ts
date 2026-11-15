import { AIJobRunner } from '../lib/ai/jobs';
import { AIAPI } from '../lib/ai/api';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { transcriptRow } from '../lib/db/repositories';
import { ServerError, type ServerClient } from '../lib/server/client';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { aiJob, briefResult, jobResponse } from './aiFixtures';

async function setup() {
  const repo = new MemoryRepositories(); await repo.putSession(session({ status: 'finalized' }));
  const get = jest.fn(), post = jest.fn(async () => ({ job_id: 'job_one', status: 'queued' }));
  let time = 0;
  const clock = { now: () => time, setTimeout: jest.fn(), clearTimeout: jest.fn() };
  const changed = jest.fn();
  const api = new AIAPI({ get, post } as unknown as ServerClient);
  const runner = new AIJobRunner({ repo, api, owner: 'owner', clock, changed, newId: () => 'brief_device_id' });
  return { repo, get, post, runner, changed, advance: (ms: number) => { time += ms; }, api, clock };
}
test('submit persists before polling and refuses unfinalized or foreign sessions', async () => {
  const { runner, repo, get, post, advance } = await setup();
  await runner.submit({ event_id: 'event-1', session_ids: [session().id], level: 'conservative' });
  expect(await repo.aiJobs('owner')).toHaveLength(1); expect(await repo.aiJobs('other')).toEqual([]);
  await runner.tick(); expect(get).not.toHaveBeenCalled(); advance(2000); get.mockResolvedValue(jobResponse()); await runner.tick(); expect(get).toHaveBeenCalledTimes(1);
  await repo.updateSession(session().id,{ status: 'stopped' });
  await expect(runner.submit({ event_id: 'event-1', session_ids: [session().id], level: 'polished' })).rejects.toMatchObject({ code: 'transcript_incomplete' });
  expect(post).toHaveBeenCalledTimes(1);
});
test('poll network/5xx failures back off to ten seconds without resubmitting', async () => {
  const { runner, repo, get, post, advance } = await setup(); await repo.putAIJob(aiJob());
  get.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new ServerError(503,'internal_error','busy')).mockResolvedValue(jobResponse());
  await runner.tick(); advance(3999); await runner.tick(); expect(get).toHaveBeenCalledTimes(1);
  advance(1); await runner.tick(); advance(7999); await runner.tick(); expect(get).toHaveBeenCalledTimes(2);
  advance(1); await runner.tick(); advance(9999); await runner.tick(); expect(get).toHaveBeenCalledTimes(3);
  advance(1); await runner.tick(); expect(get).toHaveBeenCalledTimes(4); expect(post).not.toHaveBeenCalled();
  expect((await repo.aiJobs('owner'))[0].status).toBe('running');
});
test('new runner resumes persisted jobs; terminal states never poll again', async () => {
  const { repo, get, api, clock } = await setup(); await repo.putAIJob(aiJob());
  get.mockResolvedValue(jobResponse({ status: 'failed', error_code: 'job_timeout' }));
  const runner = new AIJobRunner({ owner: 'owner', repo, api, clock, newId: () => 'id' }); await runner.tick(); await runner.tick();
  expect(get).toHaveBeenCalledTimes(1); expect((await repo.aiJobs('owner'))[0]).toMatchObject({ status: 'failed', error_code: 'job_timeout' });
});
test.each(['404','interrupted'] as const)('%s becomes a durable terminal error', async failure => {
  const { repo, get, runner, advance } = await setup(); await repo.putAIJob(aiJob());
  if (failure === '404') get.mockRejectedValue(new ServerError(404,'not_found','missing'));
  else get.mockResolvedValue(jobResponse({ status: 'interrupted' }));
  await runner.tick(); advance(60000); await runner.tick();
  expect((await repo.aiJobs('owner'))[0]).toMatchObject({ status: failure === '404' ? 'failed' : 'interrupted', error_code: failure === '404' ? 'not_found' : 'interrupted' });
  expect(get).toHaveBeenCalledTimes(1);
});
test('cleanup done fetches polished columns, preserves raw and publishes counts', async () => {
  const { repo, get, runner, changed } = await setup(); await repo.putAIJob(aiJob());
  await repo.upsertTranscript(transcriptRow(session().id,finalData()));
  const result = { accepted: 1, rejected: 0, skipped: 0, provider: 'groq', model: 'test model' };
  get.mockResolvedValueOnce(jobResponse({ status: 'done', result: result as never })).mockResolvedValueOnce({ session_id: session().id, chunks: [{ sequence: 0, polished_text: 'Cleaned', polished_level: 'polished', polish_error: null }] });
  await runner.tick(); expect((await repo.transcript(session().id))[0]).toMatchObject({ raw_text: 'original', polished_text: 'Cleaned' });
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }),result);
});
test('cleanup fetch failure leaves job pollable and retries projections', async () => {
  const { repo, get, runner, advance } = await setup(); await repo.putAIJob(aiJob());
  const done = jobResponse({ status: 'done', result: { accepted: 0, rejected: 0, skipped: 1, provider: null, model: null } });
  get.mockResolvedValueOnce(done).mockRejectedValueOnce(new Error('offline'));
  await runner.tick(); expect((await repo.aiJobs('owner'))[0].status).toBe('queued');
  advance(4000); get.mockResolvedValueOnce(done).mockResolvedValueOnce({ session_id: session().id, chunks: [] });
  await runner.tick(); expect((await repo.aiJobs('owner'))[0].status).toBe('done');
});
test('brief done atomically creates a device-id draft, with generated text separate from edits', async () => {
  const { repo, get, runner } = await setup(); await repo.putAIJob(aiJob({ kind: 'brief' }));
  get.mockResolvedValue(jobResponse({ kind: 'brief', status: 'done', result: briefResult() }));
  await runner.tick(); await runner.tick(); const rows = await repo.briefDrafts('owner','event-1');
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: 'brief_device_id', generated_text: 'Generated text', edited_text: 'Generated text', status: 'draft' });
});
test('stop during a poll prevents applying its late result', async () => {
  const { repo, get, runner } = await setup(); await repo.putAIJob(aiJob());
  let resolve!: (v: unknown) => void; get.mockImplementation(() => new Promise(r => { resolve = r; }));
  const polling = runner.tick(); await Promise.resolve(); await Promise.resolve(); await runner.stop(); resolve(jobResponse({ status: 'interrupted' })); await polling;
  expect((await repo.aiJobs('owner'))[0].status).toBe('queued');
});
