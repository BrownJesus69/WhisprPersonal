import { UploadService, nextWork, outcome } from '@/lib/upload/uploadService';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { ServerError } from '@/lib/server/client';
import type { ServerClient } from '@/lib/server/client';
import { session, chunk } from './recordingFixtures';
import { finalData, finalEvent } from './liveFixtures';

const workers: UploadService[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.stop())); });

async function setup(count = 2, stopped = false) {
  const repo = new MemoryRepositories();
  await repo.putSession(session({ next_sequence: count, status: stopped ? 'stopped' : 'recording' }));
  for (let n = count - 1; n >= 0; n--) await repo.insertChunk(chunk(n));
  const client = { post: jest.fn(async (path: string) => path.endsWith('/finalize') ? { status: 'finalized' } : {}),
    postMultipart: jest.fn(async () => ({ status: 'queued', duplicate: false })),
    get: jest.fn(async () => ({ status: 'active', chunks: [] })) };
  let now = 100000;
  let retain = true;
  const removeFile = jest.fn(); const connection = jest.fn(); const eventStatus = jest.fn();
  const worker = new UploadService({ repo, owner: 'owner', client: client as unknown as ServerClient, now: () => now,
    random: () => 1, deleteAfter: () => !retain, removeFile, connection, eventStatus });
  workers.push(worker);
  return { repo, client, worker, removeFile, connection, eventStatus, advance: (ms: number) => { now += ms; }, deleteAfter: () => { retain = false; } };
}
test('creates session once, uploads in sequence; duplicate succeeds', async () => {
  const t = await setup();
  t.client.postMultipart.mockResolvedValueOnce({ status: 'queued', duplicate: false }).mockResolvedValueOnce({ status: 'processing', duplicate: true });
  await t.worker.tick(); await t.worker.tick();
  expect(t.client.post).toHaveBeenCalledTimes(1);
  const forms = t.client.postMultipart.mock.calls as unknown as [string, FormData][];
  expect(forms.map(call => call[1].get('sequence'))).toEqual(['0','1']);
  expect((await t.repo.chunks(session().id)).map(c => c.status)).toEqual(['uploaded','uploaded']);
});
test.each([409,413,415,422])('HTTP %i permanently fails and retains file', async status => {
  const t = await setup(1); t.client.postMultipart.mockRejectedValue(new ServerError(status, 'bad_chunk', 'safe'));
  await t.worker.tick(); expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'failed_permanent', last_error: 'bad_chunk' });
  expect(t.removeFile).not.toHaveBeenCalled();
});
test.each([[0,'network_unreachable'],[0,'timeout'],[429,'rate_limited'],[503,'queue_full']] as const)('%i %s retries indefinitely', async (status,code) => {
  const t = await setup(1); t.client.postMultipart.mockRejectedValue(new ServerError(status,code,'safe',undefined,15));
  for (let i = 0; i < 30; i++) { await t.worker.tick(); t.advance(16000); }
  expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'pending', attempts: 30 });
  expect(t.removeFile).not.toHaveBeenCalled();
});
test('404 recreates once before retry, second 404 backs off', async () => {
  const t = await setup(1); t.client.postMultipart.mockRejectedValue(new ServerError(404,'session_not_found','safe'));
  await t.worker.tick(); expect(t.client.post).toHaveBeenCalledTimes(2); expect(t.client.postMultipart).toHaveBeenCalledTimes(2);
  expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
});
test.each(['missing_server_key','invalid_server_key','server_not_configured','account_not_allowed','auth_not_configured','renew_required'])('%s pauses without attempt increment', async code => {
  const t = await setup(1); t.client.postMultipart.mockRejectedValue(new ServerError(503,code,'safe'));
  await t.worker.tick(); await t.worker.tick(); expect(t.client.postMultipart).toHaveBeenCalledTimes(1);
  expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
});
test('polls at most every 10s, records failed status, deletes only done with opt-in', async () => {
  const t = await setup(1);
  t.client.get.mockResolvedValue({ status: 'active', chunks: [{ chunk_id: 'chunk_0', sequence: 0, status: 'failed', error_code: 'inference_failed' }] } as never);
  await t.worker.tick(); await t.worker.tick(); expect(t.client.get).toHaveBeenCalledTimes(1); expect(t.removeFile).not.toHaveBeenCalled();
  expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'uploaded', server_status: 'failed', last_error: 'inference_failed' });
  t.advance(10000); t.client.get.mockResolvedValue({ status: 'active', chunks: [{ chunk_id: 'chunk_0', sequence: 0, status: 'done' }] } as never);
  await t.worker.tick(); expect((await t.repo.chunks(session().id))[0].status).toBe('transcribed'); expect(t.removeFile).not.toHaveBeenCalled();
  t.deleteAfter(); await t.worker.tick(); expect(t.removeFile).toHaveBeenCalledTimes(1);
  expect((await t.repo.chunks(session().id))[0].local_deleted).toBe(1);
});
test('finalizes only after every chunk uploaded and sends expected count', async () => {
  const t = await setup(2,true); await t.worker.tick();
  expect(t.client.post.mock.calls.some(([path]) => path.endsWith('/finalize'))).toBe(false);
  await t.worker.tick(); expect(t.client.post).toHaveBeenLastCalledWith(expect.stringMatching(/\/finalize$/), { expected_chunk_count: 2, force: false });
  expect((await t.repo.session(session().id))?.status).toBe('finalized'); expect(t.eventStatus).toHaveBeenCalledWith('event-1','completed');
});
test('oldest sessions first, due times respected, owner rows isolated', async () => {
  const a = session(); const b = session({ id: 'ses_b', created_at: '2026-11-16' });
  expect(nextWork([a,b],[chunk(3,{ next_attempt_at: 10 }),chunk(0,{ session_id: b.id }),chunk(2)],0)?.sequence).toBe(2);
  expect(outcome(new Error('network'))).toBe('transient');
  const t = await setup(0); await t.repo.putSession(session({ id: 'other', owner_uid: 'other' }));
  await t.repo.insertChunk(chunk(0,{ session_id: 'other' })); await t.worker.tick(); expect(t.client.postMultipart).not.toHaveBeenCalled();
});
test('auth_unavailable (laptop briefly offline from Google) retries with backoff, never pauses', async () => {
  expect(outcome(new ServerError(503, 'auth_unavailable', 'safe'))).toBe('transient');
  const t = await setup(1); t.client.postMultipart.mockRejectedValue(new ServerError(503, 'auth_unavailable', 'safe'));
  await t.worker.tick(); t.advance(400000); await t.worker.tick();
  expect(t.client.postMultipart).toHaveBeenCalledTimes(2);
  expect((await t.repo.chunks(session().id))[0]).toMatchObject({ status: 'pending', attempts: 2 });
});

test('a paused queue probes once a minute and resumes when the cause is gone', async () => {
  jest.useFakeTimers();
  try {
    const t = await setup(1);
    t.client.postMultipart.mockRejectedValueOnce(new ServerError(401, 'invalid_server_key', 'safe'));
    t.worker.start(); await jest.advanceTimersByTimeAsync(0);
    expect(t.client.postMultipart).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(59_000);
    expect(t.client.postMultipart).toHaveBeenCalledTimes(1); // still paused
    await jest.advanceTimersByTimeAsync(2_000); // probe fires; key fixed on the laptop meanwhile
    expect(t.client.postMultipart).toHaveBeenCalledTimes(2);
    expect((await t.repo.chunks(session().id))[0].status).toBe('uploaded');
    t.worker.stop();
  } finally { jest.useRealTimers(); }
});

test('production loop serializes notifications and stops timers', async () => {
  jest.useFakeTimers();
  try {
    const t = await setup(3); let release: (() => void) | undefined;
    t.client.postMultipart.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: 'queued', duplicate: false }); }));
    t.worker.start();
    await jest.advanceTimersByTimeAsync(0); t.worker.notify(); t.worker.notify();
    expect(t.client.postMultipart).toHaveBeenCalledTimes(1);
    release!(); await jest.advanceTimersByTimeAsync(0);
    expect(t.client.postMultipart).toHaveBeenCalledTimes(2);
    t.worker.stop(); await jest.advanceTimersByTimeAsync(60000);
    expect(t.client.postMultipart).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test('202 finalizing waits ten seconds; recovered sessions wait for the owner choice', async () => {
  const t = await setup(1,true);
  t.client.post.mockImplementation(async path => path.endsWith('/finalize') ? { status: 'finalizing' } : {});
  await t.worker.tick(); expect((await t.repo.session(session().id))?.status).toBe('finalizing');
  const calls = t.client.post.mock.calls.length;
  await t.worker.tick(); expect(t.client.post).toHaveBeenCalledTimes(calls);
  t.advance(10000); t.client.post.mockResolvedValue({ status: 'finalized' });
  await t.worker.tick(); expect((await t.repo.session(session().id))?.status).toBe('finalized');
  const recovered = await setup(1,true);
  await recovered.repo.updateSession(session().id,{ finalize_status: 'interrupted' });
  await recovered.worker.tick();
  expect(recovered.client.post.mock.calls.some(([path]) => path.endsWith('/finalize'))).toBe(false);
});

test('stopping during upload never starts a status poll or another upload', async () => {
  const t = await setup(2); let release: (() => void) | undefined;
  t.client.postMultipart.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: 'queued', duplicate: false }); }));
  const pass = t.worker.tick();
  while (!release) await Promise.resolve();
  await t.worker.stop(); release(); await pass;
  expect(t.client.get).not.toHaveBeenCalled();
  expect(await t.worker.tick()).toBe(false); expect(t.client.postMultipart).toHaveBeenCalledTimes(1);
});

test('offline language override is added from its sequence boundary and Auto omits it', async () => {
  const t = await setup(3);
  await t.repo.setLanguageOverride(session().id, 'ta', 1);
  await t.worker.tick(); await t.worker.tick();
  await t.repo.setLanguageOverride(session().id, 'auto', 2); await t.worker.tick();
  const forms = t.client.postMultipart.mock.calls as unknown as [string, FormData][];
  expect(forms.map(([,form]) => form.get('language'))).toEqual([null, 'ta', null]);
  await t.worker.stop();
});

test('poll upserts done transcript idempotently without advancing stream cursor', async () => {
  const t = await setup(1);
  t.client.get.mockResolvedValue({ status: 'active', chunks: [{ ...finalData(), status: 'done' }] } as never);
  await t.worker.tick(); expect(await t.repo.transcript(session().id)).toHaveLength(1);
  expect((await t.repo.session(session().id))?.last_event_seq).toBe(0);
  expect((await t.repo.transcript(session().id))[0].revision).toBe(0); await t.worker.stop();
});

test('stale HTTP snapshot cannot replace a newer WebSocket revision', async () => {
  const t = await setup(1);
  t.client.get.mockImplementation(async () => {
    await t.repo.persistEvent(finalEvent(1, { raw_text: 'new revision' }, true));
    return { status: 'active', chunks: [{ ...finalData(), status: 'done' }] } as never;
  });
  await t.worker.tick(); expect((await t.repo.transcript(session().id))[0].raw_text).toBe('new revision'); await t.worker.stop();
});
