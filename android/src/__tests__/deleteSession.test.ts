import { deleteSession, retryServerDeletes, LaptopUnavailable, BUSY_MESSAGE } from '../lib/session/deleteSession';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { transcriptRow } from '../lib/db/repositories';
import { UploadService } from '../lib/upload/uploadService';
import { ServerClient, ServerError } from '../lib/server/client';
import { session,chunk } from './recordingFixtures';
import { finalData, finalEvent } from './liveFixtures';
import { note } from './noteFixtures';
import { aiJob } from './aiFixtures';
import { response, mockFetch } from './helpers';
async function setup() {
  const repo = new MemoryRepositories(), s = session({ status: 'stopped',server_created: 1 });
  await repo.putSession(s); await repo.insertChunk(chunk()); await repo.upsertTranscript(transcriptRow(s.id,finalData()));
  await repo.persistEvent(finalEvent()); await repo.putNote(note({ session_id: s.id })); await repo.putAIJob(aiJob({ session_ids: [s.id] }));
  return { repo, owner: 'owner', id: s.id, activeId: null, phase: 'stopped', client: { delete: jest.fn(async () => ({})) } as unknown as Pick<ServerClient,'delete'>, removeFile: jest.fn() };
}
test.each(['recording','paused','stopping'])('refuses active %s session', async phase => {
  const d = await setup(); await expect(deleteSession({ ...d,activeId: d.id,phase })).rejects.toThrow('Stop this recording'); expect(d.client.delete).not.toHaveBeenCalled();
});
test.each([200,404])('deletes files and rows, keeping event notes after %s', async status => {
  const d = await setup(); if (status === 404) jest.mocked(d.client.delete).mockRejectedValueOnce(new ServerError(404,'not_found','missing'));
  await deleteSession(d);
  expect(d.removeFile).toHaveBeenCalledWith(chunk().uri); expect(d.removeFile).toHaveBeenCalledWith(session().master_uri);
  expect(await d.repo.session(d.id)).toBeNull(); expect(await d.repo.chunks(d.id)).toEqual([]); expect(await d.repo.transcript(d.id)).toEqual([]);
  expect(await d.repo.streamEvents(d.id)).toEqual([]); expect(await d.repo.aiJobs('owner')).toEqual([]); expect(await d.repo.notes('owner','event-1')).toHaveLength(1);
});
test('busy laptop preserves all local artifacts', async () => {
  const d = await setup(); jest.mocked(d.client.delete).mockRejectedValueOnce(new ServerError(409,'session_busy','busy'));
  await expect(deleteSession(d)).rejects.toThrow(BUSY_MESSAGE); expect(d.removeFile).not.toHaveBeenCalled(); expect(await d.repo.session(d.id)).not.toBeNull();
});
test('unreachable requires explicit phone-only choice then retries through upload tick', async () => {
  const d = await setup(); jest.mocked(d.client.delete).mockRejectedValue(new ServerError(0,'network_unreachable','offline'));
  await expect(deleteSession(d)).rejects.toBeInstanceOf(LaptopUnavailable); expect(await d.repo.pendingServerDeletes('owner')).toEqual([]);
  await deleteSession({ ...d,phoneOnly: true }); expect(await d.repo.pendingServerDeletes('owner')).toHaveLength(1);
  expect(await d.repo.pendingServerDeletes('other')).toEqual([]);
  await retryServerDeletes(d.repo,d.client,'owner'); expect(await d.repo.pendingServerDeletes('owner')).toHaveLength(1);
  jest.mocked(d.client.delete).mockResolvedValue({});
  const worker = new UploadService({ ...d,client: { ...d.client,get: jest.fn(),post: jest.fn(),postMultipart: jest.fn() },deleteAfter: () => false,connection: jest.fn(),eventStatus: jest.fn() });
  await worker.tick(); expect(await d.repo.pendingServerDeletes('owner')).toEqual([]);
});
test('pending retry treats 404 as already removed', async () => {
  const d = await setup(); await d.repo.deleteSessionRows(d.id,'owner',true);
  jest.mocked(d.client.delete).mockRejectedValue(new ServerError(404,'not_found','gone')); await retryServerDeletes(d.repo,d.client,'owner');
  expect(await d.repo.pendingServerDeletes('owner')).toEqual([]);
});
test('auth failures never offer local deletion as a network fallback', async () => {
  const d = await setup(); jest.mocked(d.client.delete).mockRejectedValue(new ServerError(403,'account_not_allowed','no'));
  await expect(deleteSession({ ...d,phoneOnly: true })).rejects.toMatchObject({ status: 403 }); expect(d.removeFile).not.toHaveBeenCalled();
});
test('DELETE uses same auth and single token refresh as GET', async () => {
  const refresh = jest.fn(async () => {}), client = new ServerClient({ baseUrl: 'http://192.168.1.20:8000',getServerKey: async () => 'test-key',getBearer: async () => 'test-bearer',onAuthExpired: refresh });
  mockFetch().mockResolvedValueOnce(response({ error: { code: 'auth_token_expired' } },401)).mockResolvedValueOnce(response({ deleted: true }));
  await client.delete('/api/v1/sessions/s'); expect(refresh).toHaveBeenCalledTimes(1);
  for (const [,options] of mockFetch().mock.calls) expect(options).toMatchObject({ method: 'DELETE',headers: { Authorization: 'Bearer test-bearer','X-WhisprPersonal-Server-Key': 'test-key' } });
});


test('refuses stored recording/paused states even without an attached recorder', async () => {
  for (const status of ['recording','paused'] as const) {
    const d = await setup(); await d.repo.updateSession(d.id,{ status });
    await expect(deleteSession(d)).rejects.toThrow('Stop this recording'); expect(d.removeFile).not.toHaveBeenCalled();
  }
});
test('file failure retains retryable rows and pending intent is not prematurely created', async () => {
  const d = await setup(); d.removeFile.mockImplementation(() => { throw new Error('disk failure'); });
  await expect(deleteSession(d)).rejects.toThrow('disk failure'); expect(await d.repo.session(d.id)).not.toBeNull();
  expect(await d.repo.transcript(d.id)).toHaveLength(1);
});
