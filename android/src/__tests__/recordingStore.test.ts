import { createRecordingStore } from '@/lib/session/recordingStore';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import type { Recorder } from '@/lib/audio/recorder';
import { session } from './recordingFixtures';

async function setup() {
  const repo = new MemoryRepositories(); const s = session({ consent_at: null, status: 'paused' }); await repo.putSession(s);
  const recorder = { start: jest.fn(async () => {}), pause: jest.fn(async () => {}), resume: jest.fn(async () => {}), stop: jest.fn(async () => {}) };
  let disk = 3 * 1024 ** 3; let allowed = true;
  const write = jest.fn(async (_id, spec) => ({ uri: 'chunk.wav', chunkId: `chunk_${spec.sequence}`, sha256: 'a'.repeat(64), sizeBytes: spec.pcm.length + 44 }));
  const store = createRecordingStore({ repo: async () => repo, recorder: () => recorder as Recorder,
    permissions: async () => ({ microphone: allowed, notifications: false }), disk: () => disk,
    uid: () => 'owner', write, event: jest.fn(), notify: jest.fn(), master: () => ({ uri: 'master.wav', directory: 'dir', filename: 'master.wav' }) });
  return { store, recorder, repo, s, write, disk: (value: number) => { disk = value; }, permission: (value: boolean) => { allowed = value; }, stream: (bytes: Uint8Array) => {
    const config = (recorder.start.mock.calls as unknown as [Parameters<Recorder['start']>[0]][])[0][0]; config.onPcm(bytes);
  } };
}
test('consent, permission and storage are required; server is not', async () => {
  const t = await setup(); await t.store.getState().start(t.s,'Event',false); expect(t.recorder.start).not.toHaveBeenCalled();
  t.permission(false); await t.store.getState().start(t.s,'Event',true); expect(t.store.getState().phase).toBe('ready'); expect(t.recorder.start).not.toHaveBeenCalled();
  t.permission(true); t.disk(499 * 1024 ** 2); await t.store.getState().start(t.s,'Event',true); expect(t.recorder.start).not.toHaveBeenCalled();
  t.disk(1024 ** 3); await t.store.getState().start(t.s,'Event',true); expect(t.store.getState()).toMatchObject({ phase: 'recording', warning: expect.stringContaining('2 GB') });
  expect((await t.repo.session(t.s.id))?.consent_at).toBeTruthy();
});
test('pause/resume/stop serialize files and commit session progress', async () => {
  const t = await setup(); await t.store.getState().start(t.s,'Event',true); t.stream(new Uint8Array(10500 * 32));
  await t.store.getState().pause(); expect(t.store.getState().phase).toBe('paused');
  await t.store.getState().resume(); expect(t.store.getState().phase).toBe('recording'); t.stream(new Uint8Array(500 * 32));
  await t.store.getState().stop(); expect(t.store.getState().phase).toBe('stopped');
  const chunks = await t.repo.chunks(t.s.id); expect(chunks.map(c => [c.sequence,c.overlap_ms,c.continues])).toEqual([[0,0,1],[1,1200,0],[2,0,0]]);
  expect(await t.repo.session(t.s.id)).toMatchObject({ status: 'stopped', next_sequence: 3, time_ms: 11000 });
});
test('interruption flushes and pauses with explicit resume banner', async () => {
  const t = await setup(); await t.store.getState().start(t.s,'Event',true); t.stream(new Uint8Array(8000));
  await t.store.getState().interrupt('audio_focus_lost');
  expect(t.store.getState()).toMatchObject({ phase: 'paused', message: 'Recording paused: audio_focus_lost. Tap Resume.' });
  expect((await t.repo.chunks(t.s.id))[0].continues).toBe(0);
});

test('persistence failure retains recording status for startup master recovery', async () => {
  const t = await setup(); t.write.mockRejectedValue(new Error('disk_full'));
  await t.store.getState().start(t.s,'Event',true); t.stream(new Uint8Array(10000 * 32));
  await t.store.getState().stop();
  expect(t.store.getState().phase).toBe('error');
  expect((await t.repo.session(t.s.id))?.status).toBe('recording');
  expect(await t.repo.chunks(t.s.id)).toEqual([]);
});
