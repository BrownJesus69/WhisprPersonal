import { createRecordingStore } from '@/lib/session/recordingStore';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import type { Recorder } from '@/lib/audio/recorder';
import { session } from './recordingFixtures';

async function setup() {
  const repo = new MemoryRepositories(); const s = session({ consent_at: null, status: 'paused' }); await repo.putSession(s);
  const recorder = { start: jest.fn(async () => {}), pause: jest.fn(async () => {}), resume: jest.fn(async () => {}), stop: jest.fn(async () => {}) };
  let disk = 3 * 1024 ** 3; let allowed = true;
  const write = jest.fn(async (_id, spec) => ({ uri: 'chunk.wav', chunkId: `chunk_${spec.sequence}`, sha256: 'a'.repeat(64), sizeBytes: spec.pcm.length + 44 }));
  const wait = jest.fn(async (_ms: number) => {});
  let saved!: () => void;
  const savedChunk = new Promise<void>(resolve => { saved = resolve; });
  const notify = jest.fn(() => saved());
  const store = createRecordingStore({ repo: async () => repo, recorder: () => recorder as Recorder,
    permissions: async () => ({ microphone: allowed, notifications: false }), disk: () => disk,
    uid: () => 'owner', write, wait, event: jest.fn(), notify, master: () => ({ uri: 'master.wav', directory: 'dir', filename: 'master.wav' }) });
  return { store, recorder, repo, s, write, wait, notify, savedChunk, disk: (value: number) => { disk = value; }, permission: (value: boolean) => { allowed = value; }, stream: (bytes: Uint8Array) => {
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
  expect(t.write).toHaveBeenCalledTimes(3);
  expect(t.wait.mock.calls).toEqual([[250], [1000]]);
  expect((await t.repo.session(t.s.id))?.last_error).toBe('chunk_save_failed: disk_full');
  expect((await t.repo.session(t.s.id))?.status).toBe('recording');
  expect(await t.repo.chunks(t.s.id)).toEqual([]);
});

test('a transient insert failure reuses the file and row and keeps recording', async () => {
  const t = await setup();
  const insert = jest.spyOn(t.repo, 'insertChunk').mockRejectedValueOnce(new Error('database is locked'));
  await t.store.getState().start(t.s, 'Event', true);
  t.stream(new Uint8Array(10000 * 32));
  await t.savedChunk;
  expect(t.store.getState()).toMatchObject({ phase: 'recording', message: '' });
  expect(t.write).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledTimes(2);
  expect(insert.mock.calls[0][0]).toBe(insert.mock.calls[1][0]);
  expect(await t.repo.chunks(t.s.id)).toHaveLength(1);
  expect((await t.repo.session(t.s.id))?.last_error).toBeNull();
  expect(t.wait.mock.calls).toEqual([[250]]);
  expect(t.notify).toHaveBeenCalledTimes(1);
  // A later chunk must also be saved once, without a duplicate sequence.
  t.stream(new Uint8Array(1000 * 32));
  await t.store.getState().stop();
  expect(t.store.getState().phase).toBe('stopped');
  expect((await t.repo.chunks(t.s.id)).map(c => c.sequence)).toEqual([0, 1]);
});

test('persistent insert failure reports the cause without paths and preserves the master', async () => {
  const t = await setup();
  const insert = jest.spyOn(t.repo, 'insertChunk').mockRejectedValue(new Error('database is locked: file:///data/private/chunk.wav\n retry failed'));
  await t.store.getState().start(t.s, 'Event', true);
  t.stream(new Uint8Array(10000 * 32));
  await t.store.getState().stop();
  expect(t.store.getState()).toMatchObject({ phase: 'error', message: 'Saving audio on this phone failed. The full recording is still being kept. Tap Stop, then reopen the app to recover it.' });
  expect(t.write).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledTimes(3);
  expect(t.wait.mock.calls).toEqual([[250], [1000]]);
  expect(await t.repo.chunks(t.s.id)).toEqual([]);
  expect(await t.repo.session(t.s.id)).toMatchObject({ status: 'recording', master_uri: 'master.wav', last_error: 'chunk_save_failed: database is locked: [path] retry failed' });
});

test('a file write can recover on the third attempt using the original spec', async () => {
  const t = await setup();
  t.write.mockRejectedValueOnce(new Error('temporary write failure')).mockRejectedValueOnce(new Error('temporary write failure'));
  await t.store.getState().start(t.s, 'Event', true);
  t.stream(new Uint8Array(10000 * 32));
  await t.savedChunk;
  expect(t.store.getState()).toMatchObject({ phase: 'recording', message: '' });
  expect(t.write).toHaveBeenCalledTimes(3);
  expect(t.write.mock.calls[0][1]).toBe(t.write.mock.calls[1][1]);
  expect(t.write.mock.calls[0][1]).toBe(t.write.mock.calls[2][1]);
  expect(t.wait.mock.calls).toEqual([[250], [1000]]);
  expect(await t.repo.chunks(t.s.id)).toHaveLength(1);
});

test('an insert that committed before rejecting is not inserted again', async () => {
  const t = await setup();
  const originalInsert = t.repo.insertChunk.bind(t.repo);
  const insert = jest.spyOn(t.repo, 'insertChunk').mockImplementationOnce(async (...args) => {
    await originalInsert(...args);
    throw new Error('connection close failed after commit');
  });
  await t.store.getState().start(t.s, 'Event', true);
  t.stream(new Uint8Array(10000 * 32));
  await t.savedChunk;
  expect(t.store.getState()).toMatchObject({ phase: 'recording', message: '' });
  expect(insert).toHaveBeenCalledTimes(1);
  expect(t.write).toHaveBeenCalledTimes(1);
  expect(await t.repo.chunks(t.s.id)).toHaveLength(1);
  expect(await t.repo.session(t.s.id)).toMatchObject({ next_sequence: 1, time_ms: 10000, last_error: null });
});

test.each([
  'disk full at /data/private/chunk.wav',
  'disk full at C:\\private\\chunk.wav',
  'disk full at "C:\\private audio\\chunk.wav"',
  'disk full at "file:///private audio/chunk.wav"',
  'disk full at content://private/chunk.wav',
  'disk full at \\\\private\\audio\\chunk.wav',
  'disk full at ./private/chunk.wav',
  'disk full at private/chunk.wav',
])('save errors redact paths: %s', async message => {
  const t = await setup(); t.write.mockRejectedValue(new Error(message));
  await t.store.getState().start(t.s, 'Event', true);
  t.stream(new Uint8Array(10000 * 32));
  await t.store.getState().stop();
  expect((await t.repo.session(t.s.id))?.last_error).toBe('chunk_save_failed: disk full at [path]');
});

test('start errors persist a bounded single-line reason on the requested session', async () => {
  const t = await setup();
  t.recorder.start.mockRejectedValue(new Error(`recorder failed\n${'x'.repeat(300)}`));
  await t.store.getState().start(t.s, 'Event', true);
  const reason = (await t.repo.session(t.s.id))?.last_error;
  expect(t.store.getState().phase).toBe('error');
  expect(reason).toHaveLength(200);
  expect(reason).toMatch(/^chunk_save_failed: recorder failed x+$/);
});

test('failure remains handled when saving last_error also fails', async () => {
  const t = await setup();
  await t.store.getState().start(t.s, 'Event', true);
  jest.spyOn(t.repo, 'updateSession').mockRejectedValue(new Error('database unavailable'));
  t.write.mockRejectedValue(new Error('disk_full'));
  t.stream(new Uint8Array(10000 * 32));
  await expect(t.store.getState().stop()).resolves.toBeUndefined();
  expect(t.store.getState()).toMatchObject({ phase: 'error', busy: false });
});

test('a recorder that fails to start says nothing was recorded', async () => {
  const t = await setup();
  t.recorder.start.mockRejectedValueOnce(new Error('microphone busy'));
  await t.store.getState().start(t.s, 'Event', true);
  expect(t.store.getState()).toMatchObject({ phase: 'error', message: 'Recording could not start, so nothing was recorded. Try again.' });
  expect((await t.repo.session(t.s.id))?.last_error).toBe('chunk_save_failed: microphone busy');
});

test('microphone start failure releases the native attempt and allows retry', async () => {
  const t = await setup();
  t.recorder.start.mockRejectedValueOnce(new Error('microphone busy'));
  await t.store.getState().start(t.s, 'Event', true);
  expect((await t.repo.session(t.s.id))?.consent_at).toBeNull();
  await t.store.getState().start(t.s, 'Event', true);
  expect(t.recorder.start).toHaveBeenCalledTimes(2);
  expect(t.store.getState().phase).toBe('recording');
});
